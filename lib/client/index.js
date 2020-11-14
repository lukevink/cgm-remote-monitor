'use strict';

var _ = require('lodash');
var $ = (global && global.$) || require('jquery');
var d3 = (global && global.d3) || require('d3');
var shiroTrie = require('shiro-trie');

var Storages = require('js-storage');

var language = require('../language')();
var sandbox = require('../sandbox')();
var profile = require('../profilefunctions')();
var units = require('../units')();
var levels = require('../levels');
var times = require('../times');
var receiveDData = require('./receiveddata');
var svgColor = "#000";

var client = {};

$('#loadingMessageText').html('Connecting to server');

client.hashauth = require('../hashauth').init(client, $);

client.headers = function headers () {
  if (client.authorized) {
    return {
      Authorization: 'Bearer ' + client.authorized.token
    };
  } else if (client.hashauth) {
    return {
      'api-secret': client.hashauth.hash()
    };
  } else {
    return {};
  }
};

client.crashed = function crashed () {
  $('#centerMessagePanel').show();
  $('#loadingMessageText').html('It appears the server has crashed. Please go to Heroku or Azure and reboot the server.');
}

client.init = function init (callback) {

  client.browserUtils = require('./browser-utils')($);

  var token = client.browserUtils.queryParms().token;
  var secret = client.hashauth.apisecrethash || Storages.localStorage.get('apisecrethash');

  var src = '/api/v1/status.json?t=' + new Date().getTime();

  if (secret) {
    src += '&secret=' + secret;
  } else if (token) {
    src += '&token=' + token;
  }

  $.ajax({
    method: 'GET'
    , url: src
    , headers: client.headers()
  }).done(function success (serverSettings) {
    client.settingsFailed = false;
    console.log('Application appears to be online');
    $('#centerMessagePanel').hide();
    client.load(serverSettings, callback);
    // eslint-disable-next-line no-unused-vars
  }).fail(function fail (jqXHR, textStatus, errorThrown) {

    // check if we couldn't reach the server at all, show offline message
    if (!jqXHR.readyState) {
      console.log('Application appears to be OFFLINE');
      $('#loadingMessageText').html('Connecting to Nightscout server failed, retrying every 2 seconds');
      window.setTimeout(window.Nightscout.client.init(), 2000);
      return;
    }

    //no server setting available, use defaults, auth, etc
    if (client.settingsFailed) {
      console.log('Already tried to get settings after auth, but failed');
    } else {
      client.settingsFailed = true;

      // detect browser language
      var lang = Storages.localStorage.get('language') || (navigator.language || navigator.userLanguage).toLowerCase();
      if (lang !== 'zh_cn' && lang !== 'zh-cn' && lang !== 'zh_tw' && lang !== 'zh-tw') {
        lang = lang.substring(0, 2);
      } else {
        lang = lang.replace('-', '_');
      }
      if (language.languages.find(l => l.code === lang)) {
        language.set(lang);
      } else {
        language.set('en');
      }

      client.translate = language.translate;
      // auth failed, hide loader and request for key
      $('#centerMessagePanel').hide();
      client.hashauth.requestAuthentication(function afterRequest () {
        client.init(null, callback);
      });
    }
  });

};

client.load = function load (serverSettings, callback) {

  var FORMAT_TIME_12 = '%-I:%M %p'
    , FORMAT_TIME_12_COMPACT = '%-I:%M'
    , FORMAT_TIME_24 = '%H:%M%'
    , FORMAT_TIME_12_SCALE = '%-I %p'
    , FORMAT_TIME_24_SCALE = '%H';

  var history = 48;

  var chart
    , socket
    , isInitialData = false
    , opacity = { current: 1, DAY: 1, NIGHT: 0.5 }
    , clientAlarms = {}
    , alarmInProgress = false
    , alarmMessage
    , currentNotify
    , currentAnnouncement
    , alarmSound = 'alarm.mp3'
    , urgentAlarmSound = 'alarm2.mp3'
    , previousNotifyTimestamp;

  client.entryToDate = function entryToDate (entry) {
    if (entry.date) return entry.date;
    entry.date = new Date(entry.mills);
    return entry.date;
  };

  client.now = Date.now();
  client.ddata = require('../data/ddata')();
  client.forecastTime = client.defaultForecastTime = times.mins(30).msecs;
  client.entries = [];
  client.ticks = require('./ticks');

  //containers
  var container = $('.container')
    , bgStatus = $('.bgStatus')
    , currentBG = $('.bgStatus .currentBG')
    , majorPills = $('.bgStatus .majorPills')
    , minorPills = $('.bgStatus .minorPills')
    , statusPills = $('.status .statusPills')
    , primary = $('.primary')
    , editButton = $('#editbutton');

  client.tooltip = d3.select('body').append('div')
    .attr('class', 'tooltip')
    .style('opacity', 0);

  var browserSettings = require('./browser-settings');
  client.settings = browserSettings(client, serverSettings, $);

  language.set(client.settings.language).DOMtranslate($);
  client.translate = language.translate;
  client.language = language;

  client.plugins = require('../plugins/')({
    settings: client.settings
    , extendedSettings: client.settings.extendedSettings
    , language: language
  }).registerClientDefaults();

  browserSettings.loadPluginSettings(client);

  client.utils = require('../utils')({
    settings: client.settings
    , language: language
  });

  client.rawbg = client.plugins('rawbg');
  client.delta = client.plugins('delta');
  client.timeago = client.plugins('timeago');
  client.direction = client.plugins('direction');
  client.errorcodes = client.plugins('errorcodes');

  client.ctx = {
    data: {}
    , bus: require('../bus')(client.settings, client.ctx)
    , settings: client.settings
    , notifications: require('../notifications')(client.settings, client.ctx)
    , pluginBase: client.plugins.base(majorPills, minorPills, statusPills, bgStatus, client.tooltip, Storages.localStorage)
  };

  client.ctx.language = language;
  levels.translate = language.translate;
  client.ctx.levels = levels;

  client.sbx = sandbox.clientInit(client.ctx, client.now);
  client.renderer = require('./renderer')(client, d3, $);

  //After plugins are initialized with browser settings;
  browserSettings.loadAndWireForm();

  if (serverSettings && serverSettings.authorized) {
    client.authorized = serverSettings.authorized;
    client.authorized.lat = Date.now();
    client.authorized.shiros = _.map(client.authorized.permissionGroups, function toShiro (group) {
      var shiro = shiroTrie.new();
      _.forEach(group, function eachPermission (permission) {
        shiro.add(permission);
      });
      return shiro;
    });

    client.authorized.check = function check (permission) {
      var found = _.find(client.authorized.shiros, function checkEach (shiro) {
        return shiro.check(permission);
      });

      return _.isObject(found);
    };
  }

  client.afterAuth = function afterAuth (isAuthenticated) {

    var treatmentCreateAllowed = client.authorized ? client.authorized.check('api:treatments:create') : isAuthenticated;
    var treatmentUpdateAllowed = client.authorized ? client.authorized.check('api:treatments:update') : isAuthenticated;

    $('#lockedToggle').click(client.hashauth.requestAuthentication).toggle(!treatmentCreateAllowed && client.settings.showPlugins.indexOf('careportal') > -1);
    $('#treatmentDrawerToggle').toggle(treatmentCreateAllowed && client.settings.showPlugins.indexOf('careportal') > -1);
    $('#boluscalcDrawerToggle').toggle(treatmentCreateAllowed && client.settings.showPlugins.indexOf('boluscalc') > -1);

    // Edit mode
    editButton.toggle(client.settings.editMode && treatmentUpdateAllowed);
    editButton.click(function editModeClick (event) {
      client.editMode = !client.editMode;
      if (client.editMode) {
        client.renderer.drawTreatments(client);
        editButton.find('i').addClass('selected');
      } else {
        chart.focus.selectAll('.draggable-treatment')
          .style('cursor', 'default')
          .on('mousedown.drag', null);
        editButton.find('i').removeClass('selected');
      }
      if (event) { event.preventDefault(); }
    });
  };

  client.hashauth.initAuthentication(client.afterAuth);

  client.focusRangeMS = times.hours(client.settings.focusHours).msecs;
  $('.focus-range li[data-hours=' + client.settings.focusHours + ']').addClass('selected');
  client.brushed = brushed;
  client.formatTime = formatTime;
  client.dataUpdate = dataUpdate;

  client.careportal = require('./careportal')(client, $);
  client.boluscalc = require('./boluscalc')(client, $);

  client.profilefunctions = profile;

  client.editMode = false;

  //TODO: use the bus for updates and notifications
  //client.ctx.bus.on('tick', function timedReload (tick) {
  //  console.info('tick', tick.now);
  //});
  //broadcast 'tock' event each minute, start a new setTimeout each time it fires make it happen on the minute
  //see updateClock
  //start the bus after setting up listeners
  //client.ctx.bus.uptime( );

  client.dataExtent = function dataExtent () {
    if (client.entries.length > 0) {
      return [client.entryToDate(client.entries[0]), client.entryToDate(client.entries[client.entries.length - 1])];
    } else {
      return [new Date(client.now - times.hours(history).msecs), new Date(client.now)];
    }
  };

  client.bottomOfPills = function bottomOfPills () {
    //the offset's might not exist for some tests
    var bottomOfPrimary = primary.offset() ? primary.offset().top + primary.height() : 0;
    var bottomOfMinorPills = minorPills.offset() ? minorPills.offset().top + minorPills.height() : 0;
    var bottomOfStatusPills = statusPills.offset() ? statusPills.offset().top + statusPills.height() : 0;
    return Math.max(bottomOfPrimary, bottomOfMinorPills, bottomOfStatusPills);
  };

  function formatTime (time, compact) {
    var timeFormat = getTimeFormat(false, compact);
    time = d3.timeFormat(timeFormat)(time);
    if (client.settings.timeFormat !== 24) {
      time = time.toLowerCase();
    }
    return time;
  }

  function getTimeFormat (isForScale, compact) {
    var timeFormat = FORMAT_TIME_12;
    if (client.settings.timeFormat === 24) {
      timeFormat = isForScale ? FORMAT_TIME_24_SCALE : FORMAT_TIME_24;
    } else {
      timeFormat = isForScale ? FORMAT_TIME_12_SCALE : (compact ? FORMAT_TIME_12_COMPACT : FORMAT_TIME_12);
    }

    return timeFormat;
  }

  //TODO: replace with utils.scaleMgdl and/or utils.roundBGForDisplay
  function scaleBg (bg) {
    if (client.settings.units === 'mmol') {
      return units.mgdlToMMOL(bg);
    } else {
      return bg;
    }
  }

  function generateTitle () {
    function s (value, sep) { return value ? value + ' ' : sep || ''; }

    var title = '';

    var status = client.timeago.checkStatus(client.sbx);

    if (status !== 'current') {
      var ago = client.timeago.calcDisplay(client.sbx.lastSGVEntry(), client.sbx.time);
      title = s(ago.value) + s(ago.label, ' - ') + title;
    } else if (client.latestSGV) {
      var currentMgdl = client.latestSGV.mgdl;

      if (currentMgdl < 39) {
        title = s(client.errorcodes.toDisplay(currentMgdl), ' - ') + title;
      } else {
        var delta = client.nowSBX.properties.delta;
        if (delta) {
          var deltaDisplay = delta.display;
          title = s(scaleBg(currentMgdl)) + s(deltaDisplay) + s(client.direction.info(client.latestSGV).label) + title;
        }
      }
    }
    return title;
  }

  function resetCustomTitle () {
    var customTitle = client.settings.customTitle || 'Nightscout';
    $('.customTitle').text(customTitle);
  }

  function checkAnnouncement () {
    var result = {
      inProgress: currentAnnouncement ? Date.now() - currentAnnouncement.received < times.mins(5).msecs : false
    };

    if (result.inProgress) {
      var message = currentAnnouncement.message.length > 1 ? currentAnnouncement.message : currentAnnouncement.title;
      result.message = message;
      $('.customTitle').text(message);
    } else if (currentAnnouncement) {
      currentAnnouncement = null;
      console.info('cleared announcement');
    }

    return result;
  }
  

  function updateTitle () {

    var windowTitle;
    var announcementStatus = checkAnnouncement();

    if (alarmMessage && alarmInProgress) {
      $('.customTitle').text(alarmMessage);
      if (!isTimeAgoAlarmType()) {
        windowTitle = alarmMessage + ': ' + generateTitle();
      }
    } else if (announcementStatus.inProgress && announcementStatus.message) {
      windowTitle = announcementStatus.message + ': ' + generateTitle();
    } else {
      resetCustomTitle();
    }

    container.toggleClass('announcing', announcementStatus.inProgress);

    $(document).attr('title', windowTitle || generateTitle());
    
    
  }

  // clears the current user brush and resets to the current real time data
  function updateBrushToNow (skipBrushing) {

    // update brush and focus chart with recent data
    var brushExtent = client.dataExtent();

    brushExtent[0] = new Date(brushExtent[1].getTime() - client.focusRangeMS);

    // console.log('Resetting brush in updateBrushToNow: ', brushExtent);

    chart.theBrush && chart.theBrush.call(chart.brush.move, brushExtent.map(chart.xScale2));

    if (!skipBrushing) {
      brushed();
    }
  }

  function alarmingNow () {
    return container.hasClass('alarming');
  }

  function inRetroMode () {
    return chart && chart.inRetroMode();
  }

  function brushed () {
    // Brush not initialized
    console.log("brushed");
    if (!chart.theBrush) {
      return;
    }

    // default to most recent focus period
    var brushExtent = client.dataExtent();
    brushExtent[0] = new Date(brushExtent[1].getTime() - client.focusRangeMS);

    var brushedRange = d3.brushSelection(chart.theBrush.node());

    if (brushedRange) {
      brushExtent = brushedRange.map(chart.xScale2.invert);
    }

    // console.log('Brushed to: ', brushExtent);

    if (!brushedRange || (brushExtent[1].getTime() - brushExtent[0].getTime() !== client.focusRangeMS)) {
      // ensure that brush updating is with the time range
      if (brushExtent[0].getTime() + client.focusRangeMS > client.dataExtent()[1].getTime()) {
        brushExtent[0] = new Date(brushExtent[1].getTime() - client.focusRangeMS);
      } else {
        brushExtent[1] = new Date(brushExtent[0].getTime() + client.focusRangeMS);
      }

      // console.log('Updating brushed to: ', brushExtent);

      chart.theBrush.call(chart.brush.move, brushExtent.map(chart.xScale2));
    }
	

    function adjustCurrentSGVClasses (value, isCurrent) {
      var reallyCurrentAndNotAlarming = isCurrent && !inRetroMode() && !alarmingNow();

      bgStatus.toggleClass('current', alarmingNow() || reallyCurrentAndNotAlarming);
      if (!alarmingNow()) {
        container.removeClass('urgent warning inrange');
        if (reallyCurrentAndNotAlarming) {
		  svgColor = sgvToColor(value);
          container.addClass(sgvToColoredRange(value));
        }
      }
      currentBG.toggleClass('icon-hourglass', value === 9);
      currentBG.toggleClass('error-code', value < 39);
      currentBG.toggleClass('bg-limit', value === 39 || value > 400);
    }

    function updateCurrentSGV (entry) {
      var value = entry.mgdl
        , isCurrent = 'current' === client.timeago.checkStatus(client.sbx);

      if (value === 9) {
        currentBG.text('');
      } else if (value < 39) {
        currentBG.html(client.errorcodes.toDisplay(value));
      } else if (value < 40) {
        currentBG.text('LOW');
      } else if (value > 400) {
        currentBG.text('HIGH');
      } else {
        currentBG.text(scaleBg(value));
      }

      adjustCurrentSGVClasses(value, isCurrent);
      
    }

    function mergeDeviceStatus (retro, ddata) {
      if (!retro) {
        return ddata;
      }

      var result = retro.map(x => Object.assign(x, ddata.find(y => y._id == x._id)));

      var missingInRetro = ddata.filter(y => !retro.find(x => x._id == y._id));

      result.push(...missingInRetro);

      return result;
    }

    function updatePlugins (time) {

      //TODO: doing a clone was slow, but ok to let plugins muck with data?
      //var ddata = client.ddata.clone();

      client.ddata.inRetroMode = inRetroMode();
      client.ddata.profile = profile;

      // retro data only ever contains device statuses
      // Cleate a clone of the data for the sandbox given to plugins

      var mergedStatuses = client.ddata.devicestatus;

      if (client.retro.data) {
        mergedStatuses = mergeDeviceStatus(client.retro.data.devicestatus, client.ddata.devicestatus);
      }

      var clonedData = _.clone(client.ddata);
      clonedData.devicestatus = mergedStatuses;

      client.sbx = sandbox.clientInit(
        client.ctx
        , new Date(time).getTime() //make sure we send a timestamp
        , clonedData
      );

      //all enabled plugins get a chance to set properties, even if they aren't shown
      client.plugins.setProperties(client.sbx);

      //only shown plugins get a chance to update visualisations
      client.plugins.updateVisualisations(client.sbx);

      var viewMenu = $('#viewMenu');
      viewMenu.empty();

      _.each(client.sbx.pluginBase.forecastInfos, function eachInfo (info) {
        var forecastOption = $('<li/>');
        var forecastLabel = $('<label/>');
        var forecastCheckbox = $('<input type="checkbox" data-forecast-type="' + info.type + '"/>');
        forecastCheckbox.prop('checked', client.settings.showForecast.indexOf(info.type) > -1);
        forecastOption.append(forecastLabel);
        forecastLabel.append(forecastCheckbox);
        forecastLabel.append('<span>Show ' + info.label + '</span>');
        forecastCheckbox.change(function onChange (event) {
          var checkbox = $(event.target);
          var type = checkbox.attr('data-forecast-type');
          var checked = checkbox.prop('checked');
          if (checked) {
            client.settings.showForecast += ' ' + type;
          } else {
            client.settings.showForecast = _.chain(client.settings.showForecast.split(' '))
              .filter(function(forecast) { return forecast !== type; })
              .value()
              .join(' ');
          }
          Storages.localStorage.set('showForecast', client.settings.showForecast);
          refreshChart(true);
        });
        viewMenu.append(forecastOption);
      });

      //send data to boluscalc too
      client.boluscalc.updateVisualisations(client.sbx);
    }

    function clearCurrentSGV () {
      currentBG.text('---');
      container.removeClass('alarming urgent warning inrange');
    }

    var nowDate = null;
    var nowData = client.entries.filter(function(d) {
      return d.type === 'sgv' && d.mills <= brushExtent[1].getTime();
    });
    var focusPoint = _.last(nowData);

    function updateHeader () {
      if (inRetroMode()) {
        nowDate = brushExtent[1];
        $('#currentTime')
          .text(formatTime(nowDate, true))
          .css('text-decoration', 'line-through');
      } else {
        nowDate = new Date(client.now);
        updateClockDisplay();
      }

      if (focusPoint) {
        if (brushExtent[1].getTime() - focusPoint.mills > times.mins(15).msecs) {
          clearCurrentSGV();
        } else {
          updateCurrentSGV(focusPoint);
        }
        updatePlugins(nowDate.getTime());
      } else {
        clearCurrentSGV();
        updatePlugins(nowDate);
      }
    }

    updateHeader();
    updateTimeAgo();
    if (chart.prevChartHeight) {
      chart.scroll(nowDate);
    }

    var top = (client.bottomOfPills() + 5);
    $('#chartContainer').css({ top: top + 'px', height: $(window).height() - top - 10 });
    container.removeClass('loading');
    
    
    coolSVGs();
    
    
  }
  
  
  function coolSVGs(){
	// Update Direction to cool SVGs
    var directionCSS = client.direction.info(client.latestSGV).value;
    console.log('DIRECTION: ' + directionCSS);
    
    var arrowCount = 1;
    var arrowDirection = 'fortyfive';
    switch(directionCSS) {
			  case "DoubleDown":
			  	arrowCount = 2;
			    arrowDirection = 'down';
			    break;
			  case "SingleDown":
			  	arrowCount = 1;
			    arrowDirection = 'down';
			    break;
			  case "FortyFiveUp":
			  	arrowCount = 1;
			    arrowDirection = '45Up';
			    break;			    
			  case "FortyFiveDown":
			  	arrowCount = 1;
			    arrowDirection = '45Down';
			    break;
			  case "Flat":
			  	arrowCount = 1;
			    arrowDirection = 'flat';
			    break;
			  case "SingleUp":
			  	arrowCount = 1;
			    arrowDirection = 'up';
			    break;
			  case "DoubleUp":
			  	arrowCount = 2;
			    arrowDirection = 'up';
			    break;
			  case "NONE":
			  	arrowCount = 0;
			    arrowDirection = 'none';
			    break;
			  case "NOT COMPUTABLE":
			  	arrowCount = 0;
			    arrowDirection = 'notcompute';
			    break;
			  case "RATE OUT OF RANGE":
			  	arrowCount = 0;
			    arrowDirection = 'outofrange';
			    break;			    
			  default:		  
	}
	
	var directionHtml;
	if(arrowCount == 1){
		 directionHtml = '<span id="sugar-direction">'+
		'						<span class="center-con one">'+
		'						    <div class="round '+ arrowDirection +'">'+
		'						        <div id="cta">'+
		'						            <span class="arrow first next "></span>'+
		'						        </div>'+
		'						    </div>'+
		'						</span>'+
		'					</span>';
	}
	if(arrowCount == 2){
		 directionHtml = '<span id="sugar-direction">'+
		'						<span class="center-con two">'+
		'						    <div class="round '+ arrowDirection +'">'+
		'						        <div id="cta">'+
		'						            <span class="arrow first next "></span>'+
		'						            <span class="arrow second next "></span>'+
		'						        </div>'+
		'						    </div>'+
		'						</span>'+
		'					</span>';
	}
	
var encodedsvgColor = encodeURIComponent(svgColor);

var background = `url('data:image/svg+xml;utf8, <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="${encodedsvgColor}" d="M319.1 217c20.2 20.2 19.9 53.2-.6 73.7s-53.5 20.8-73.7.6l-190-190c-20.1-20.2-19.8-53.2.7-73.7S109 6.8 129.1 27l190 190z"/><path fill="${encodedsvgColor}" d="M319.1 290.5c20.2-20.2 19.9-53.2-.6-73.7s-53.5-20.8-73.7-.6l-190 190c-20.2 20.2-19.9 53.2.6 73.7s53.5 20.8 73.7.6l190-190z"/></svg>')`;
	
		if(arrowDirection == "none"){
		background = `url('data:image/svg+xml;utf8, <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 65 65"><path fill="${encodedsvgColor}" d="m80.602 47.25c0-8.793-3.1172-16.309-9.3516-22.551-6.1719-6.168-13.656-9.25-22.449-9.25s-16.309 3.082-22.551 9.25c-6.168 6.2422-9.25 13.758-9.25 22.551s3.082 16.277 9.25 22.449c6.2422 6.2383 13.758 9.3516 22.551 9.3516 8.793 0.003907 16.277-3.1133 22.449-9.3516 6.2383-6.1719 9.3555-13.656 9.3516-22.449z"/></svg>')`;
	}
	if(arrowDirection == "notcompute"){
		background = `url('data:image/svg+xml;utf8, <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 484 484"><path d="M413.215,413.215 C457.020872,369.409128 484,308.8162 484,242 C484,175.20316 457.020872,114.59184 413.215,70.785 C369.409128,26.97816 308.8162,0 242,0 C175.20316,0 114.59184,26.979128 70.785,70.785 C26.9781552,114.590872 0,175.1838 0,242 C0,308.79684 26.979128,369.40816 70.785,413.215 C114.590872,457.021845 175.1838,484 242,484 C308.79684,484 369.40816,457.020872 413.215,413.215 Z M274.74744,335.35876 C274.74744,317.227636 260.151936,302.613256 242.001936,302.613256 C223.870812,302.613256 208.821316,317.20876 208.821316,335.35876 C208.821316,353.489884 223.870812,368.53938 242.001936,368.53938 C260.13306,368.53938 274.74744,353.489884 274.74744,335.35876 Z M242.001936,269.43312 C230.052944,269.43312 221.20494,259.696492 219.881684,247.312868 L208.821316,148.659148 C207.044116,131.397772 225.194068,115.478528 242.001936,115.478528 C258.809804,115.478528 276.959804,131.397772 274.74744,148.659148 L264.122188,247.312868 C262.798738,259.696492 253.950444,269.43312 242.001936,269.43312 Z" fill="${encodedsvgColor}"></path></svg>')`;
	}
	if(arrowDirection == "outofrange"){
		background = `url('data:image/svg+xml;utf8, <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 414 414"> <path d="M407.448438,97.1399973 C416.183854,107.360238 416.183854,123.935489 407.448438,134.175315 C398.713023,144.395556 384.545871,144.395556 375.793716,134.175315 C282.722394,25.2839486 131.273326,25.2839486 38.2062969,134.175315 C29.4708683,144.395556 15.3037169,144.395556 6.55156177,134.175315 C-2.18385392,123.955074 -2.18385392,107.379823 6.55156177,97.1399973 C33.6123791,65.4794459 65.1653899,40.9768797 100.34398,24.2846227 C134.312609,8.16032422 170.190393,-5.68434189e-14 207.012883,-5.68434189e-14 C243.83533,-5.68434189e-14 279.713586,8.16032422 313.681743,24.2846227 C348.857371,40.9778841 380.412043,65.4784415 407.474148,97.1399973 L407.448438,97.1399973 Z M322.480896,175.238444 C331.173035,185.458685 331.173035,202.033935 322.480896,212.273761 C313.788758,222.494002 299.691795,222.494002 290.983,212.273761 C244.669348,157.818035 169.330652,157.818035 123.017,212.273761 C114.324862,222.494002 100.227898,222.494002 91.5191035,212.273761 C82.8269655,202.05352 82.8269655,185.47827 91.5191035,175.238444 C122.366541,138.967937 163.372745,119 206.982916,119 C250.593088,119 291.59801,138.969443 322.446729,175.238444 L322.480896,175.238444 Z M206.95571,362.687933 L161.602091,408.041555 C143.378441,426.265204 115.849208,398.532977 133.876581,380.512316 L179.433184,334.955709 L133.876581,289.60209 C115.85592,271.378441 143.385152,243.849206 161.602091,261.876577 L206.95571,307.433184 L252.512317,261.876577 C270.532978,243.855916 298.265201,271.385151 280.041552,289.60209 L234.687933,334.955709 L280.041552,380.512316 C298.265201,398.532977 270.532978,426.265204 252.512317,408.041555 L206.95571,362.687933 Z" fill="${encodedsvgColor}"></path></svg>')`;
	}

	var hoursHtml = `<svg width=&#34;21px&#34; height=&#34;21px&#34; version=&#34;1.1&#34; viewBox=&#34;0 0 100 100&#34; xmlns=&#34;http://www.w3.org/2000/svg&#34;>
 <path d=&#34;m43.023 57.559v-4.6445c0-0.64844-0.40234-0.83594-0.89453-0.42578l-8.6797 7.2344c-0.49219 0.41016-0.49219 1.0742 0 1.4844l8.6797 7.2344c0.49609 0.41406 0.89453 0.21875 0.89453-0.42578v-4.6445h16.277v4.6445c0 0.64453 0.39844 0.83984 0.89453 0.42578l8.6797-7.2344c0.49219-0.41016 0.49609-1.0742 0-1.4844l-8.6797-7.2344c-0.49219-0.41016-0.89453-0.22266-0.89453 0.42578v4.6445zm29.07-32.559h4.6562c2.5664 0 4.6445 2.0859 4.6445 4.6641v46.488c0 2.5742-2.082 4.6602-4.6445 4.6602h-51.176c-2.5664 0-4.6445-2.0859-4.6445-4.6602v-46.488c0-2.5781 2.082-4.6641 4.6445-4.6641h4.6602v5.8047c0 2.582 2.0859 4.6602 4.6602 4.6602h2.3047c2.582 0 4.6602-2.0859 4.6602-4.6602v-5.8047h18.605v5.8047c0 2.582 2.0859 4.6602 4.6641 4.6602h2.3008c2.5859 0 4.6641-2.0859 4.6641-4.6602zm-47.676 19.766c0-0.64062 0.53125-1.1602 1.168-1.1602h51.152c0.64453 0 1.168 0.52734 1.168 1.1602v31.398c0 0.64063-0.52734 1.1602-1.168 1.1602h-51.152c-0.64453 0-1.168-0.52734-1.168-1.1602zm8.1406-23.242c0-1.293 1.043-2.3359 2.3242-2.3359h2.3281c1.2852 0 2.3242 1.0469 2.3242 2.3359v9.2812c0 1.2891-1.043 2.3359-2.3242 2.3359h-2.3281c-1.2852 0-2.3242-1.0508-2.3242-2.3359zm30.23 0c0-1.293 1.0469-2.3359 2.3242-2.3359h2.332c1.2812 0 2.3203 1.0469 2.3203 2.3359v9.2812c0 1.2891-1.043 2.3359-2.3203 2.3359h-2.332c-1.2812 0-2.3242-1.0508-2.3242-2.3359z&#34; fill-rule=&#34;evenodd&#34;/>
</svg>`

	
	setTimeout(function(){ 
				
		$('.arrow.next').css("background-image", background);
		$('.focus-range li:first-child').html(hoursHtml);
	
	 	$('.center-con .round').css("border",'2px solid #000');
	 	$('.center-con .round').css("border",'2px solid '+ svgColor);		
		
		 }, 130);

 
 	
	$('.bgStatus .pill.direction').empty().html(directionHtml);
	   	
  
  }

  function sgvToColor (sgv) {
    var color = 'grey';

    if (client.settings.theme !== 'default') {
      if (sgv > client.settings.thresholds.bgHigh) {
        color = 'red';
      } else if (sgv > client.settings.thresholds.bgTargetTop) {
        color = 'yellow';
      } else if (sgv >= client.settings.thresholds.bgTargetBottom && sgv <= client.settings.thresholds.bgTargetTop && client.settings.theme === 'colors') {
        color = '#4cff00';
      } else if (sgv < client.settings.thresholds.bgLow) {
        color = 'red';
      } else if (sgv < client.settings.thresholds.bgTargetBottom) {
        color = 'yellow';
      }
    }

    return color;
  }

  function sgvToColoredRange (sgv) {
    var range = '';

    if (client.settings.theme !== 'default') {
      if (sgv > client.settings.thresholds.bgHigh) {
        range = 'urgent';
      } else if (sgv > client.settings.thresholds.bgTargetTop) {
        range = 'warning';
      } else if (sgv >= client.settings.thresholds.bgTargetBottom && sgv <= client.settings.thresholds.bgTargetTop && client.settings.theme === 'colors') {
        range = 'inrange';
      } else if (sgv < client.settings.thresholds.bgLow) {
        range = 'urgent';
      } else if (sgv < client.settings.thresholds.bgTargetBottom) {
        range = 'warning';
      }
    }

    return range;
  }

  function formatAlarmMessage (notify) {
    var announcementMessage = notify && notify.isAnnouncement && notify.message && notify.message.length > 1;

    if (announcementMessage) {
      return levels.toDisplay(notify.level) + ': ' + notify.message;
    } else if (notify) {
      return notify.title;
    }
    return null;
  }

  function setAlarmMessage (notify) {
    alarmMessage = formatAlarmMessage(notify);
  }

  function generateAlarm (file, notify) {
    alarmInProgress = true;

    currentNotify = notify;
    setAlarmMessage(notify);
    var selector = '.audio.alarms audio.' + file;

    if (!alarmingNow()) {
      d3.select(selector).each(function() {
        var audio = this;
        playAlarm(audio);
        $(this).addClass('playing');
      });

      console.log('Asking plugins to visualize alarms');
      client.plugins.visualizeAlarm(client.sbx, notify, alarmMessage);
    }

    container.addClass('alarming').addClass(file === urgentAlarmSound ? 'urgent' : 'warning');

    var silenceBtn = $('#silenceBtn');
    silenceBtn.empty();

    _.each(client.settings.snoozeMinsForAlarmEvent(notify), function eachOption (mins) {
      var snoozeOption = $('<li><a data-snooze-time="' + times.mins(mins).msecs + '">' + client.translate('Silence for %1 minutes', { params: [mins] }) + '</a></li>');
      snoozeOption.click(snoozeAlarm);
      silenceBtn.append(snoozeOption);
    });

    updateTitle();
  }

  function snoozeAlarm (event) {
    stopAlarm(true, $(event.target).data('snooze-time'));
    event.preventDefault();
  }

  function playAlarm (audio) {
    // ?mute=true disables alarms to testers.
    if (client.browserUtils.queryParms().mute !== 'true') {
      audio.play();
    } else {
      client.browserUtils.showNotification('Alarm was muted (?mute=true)');
    }
  }

  function stopAlarm (isClient, silenceTime, notify) {
    alarmInProgress = false;
    alarmMessage = null;
    container.removeClass('urgent warning');
    d3.selectAll('audio.playing').each(function() {
      var audio = this;
      audio.pause();
      $(this).removeClass('playing');
    });

    client.browserUtils.closeNotification();
    container.removeClass('alarming');

    updateTitle();

    silenceTime = silenceTime || times.mins(5).msecs;

    var alarm = null;

    if (notify) {
      if (notify.level) {
        alarm = getClientAlarm(notify.level, notify.group);
      } else if (notify.group) {
        alarm = getClientAlarm(currentNotify.level, notify.group);
      } else {
        alarm = getClientAlarm(currentNotify.level, currentNotify.group);
      }
    } else if (currentNotify) {
      alarm = getClientAlarm(currentNotify.level, currentNotify.group);
    }

    if (alarm) {
      alarm.lastAckTime = Date.now();
      alarm.silenceTime = silenceTime;
      if (alarm.group === 'Time Ago') {
        container.removeClass('alarming-timeago');
      }
    } else {
      console.info('No alarm to ack for', notify || currentNotify);
    }

    // only emit ack if client invoke by button press
    if (isClient && currentNotify) {
      socket.emit('ack', currentNotify.level, currentNotify.group, silenceTime);
    }

    currentNotify = null;

    brushed();
  }

  function refreshAuthIfNeeded () {
    var token = client.browserUtils.queryParms().token;
    if (token && client.authorized) {
      var renewTime = (client.authorized.exp * 1000) - times.mins(15).msecs - Math.abs((client.authorized.iat * 1000) - client.authorized.lat);
      var refreshIn = Math.round((renewTime - client.now) / 1000);
      if (client.now > renewTime) {
        console.info('Refreshing authorization');
        $.ajax('/api/v2/authorization/request/' + token, {
          success: function(authorized) {
            if (authorized) {
              console.info('Got new authorization', authorized);
              authorized.lat = client.now;
              client.authorized = authorized;
            }
          }
        });
      } else if (refreshIn < times.mins(5).secs) {
        console.info('authorization refresh in ' + refreshIn + 's');
      }
    }
  }

  function updateClock () {
    updateClockDisplay();
    var interval = (60 - (new Date()).getSeconds()) * 1000 + 5;
    setTimeout(updateClock, interval);

    updateTimeAgo();
    if (chart) {
      brushed();
    }

    // Dim the screen by reducing the opacity when at nighttime
    if (client.settings.nightMode) {
      var dateTime = new Date();
      if (opacity.current !== opacity.NIGHT && (dateTime.getHours() > 21 || dateTime.getHours() < 7)) {
        $('body').css({ 'opacity': opacity.NIGHT });
      } else {
        $('body').css({ 'opacity': opacity.DAY });
      }
    }
    refreshAuthIfNeeded();
    if (client.resetRetroIfNeeded) {
      client.resetRetroIfNeeded();
    }
  }

  function updateClockDisplay () {
    if (inRetroMode()) {
      return;
    }
    client.now = Date.now();
    $('#currentTime').text(formatTime(new Date(client.now), true)).css('text-decoration', '');
  }

  function getClientAlarm (level, group) {
    var key = level + '-' + group;
    var alarm = clientAlarms[key];
    if (!alarm) {
      alarm = { level: level, group: group };
      clientAlarms[key] = alarm;
    }
    return alarm;
  }

  function isTimeAgoAlarmType () {
    return currentNotify && currentNotify.group === 'Time Ago';
  }

  function isStale (status) {
    return client.settings.alarmTimeagoWarn && status === 'warn' ||
      client.settings.alarmTimeagoUrgent && status === 'urgent';
  }

  function notAcked (alarm) {
    return Date.now() >= (alarm.lastAckTime || 0) + (alarm.silenceTime || 0);
  }

  function checkTimeAgoAlarm (status) {
    var level = status === 'urgent' ? levels.URGENT : levels.WARN;
    var alarm = getClientAlarm(level, 'Time Ago');

    if (isStale(status) && notAcked(alarm)) {
      console.info('generating timeAgoAlarm', alarm);
      container.addClass('alarming-timeago');
      var display = client.timeago.calcDisplay(client.sbx.lastSGVEntry(), client.sbx.time);
      var translate = client.translate;
      var notify = {
        title: translate('Last data received') + ' ' + display.value + ' ' + translate(display.label)
        , level: status === 'urgent' ? 2 : 1
        , group: 'Time Ago'
      };
      var sound = status === 'warn' ? alarmSound : urgentAlarmSound;
      generateAlarm(sound, notify);
    }

    container.toggleClass('alarming-timeago', status !== 'current');

    if (status === 'warn') {
      container.addClass('warn');
    } else if (status === 'urgent') {
      container.addClass('urgent');
    }

    if (alarmingNow() && status === 'current' && isTimeAgoAlarmType()) {
      stopAlarm(true, times.min().msecs);
    }
  }

  function updateTimeAgo () {
    var status = client.timeago.checkStatus(client.sbx);
    if (status !== 'current') {
      updateTitle();
    }
    checkTimeAgoAlarm(status);
  }

  function updateTimeAgoSoon () {
    setTimeout(function updatingTimeAgoNow () {
      updateTimeAgo();
    }, times.secs(10).msecs);
  }

  function refreshChart (updateToNow) {
    if (updateToNow) {
      updateBrushToNow();
    }
    chart.update(false);
  }

  (function watchVisibility () {
    // Set the name of the hidden property and the change event for visibility
    var hidden, visibilityChange;
    if (typeof document.hidden !== 'undefined') {
      hidden = 'hidden';
      visibilityChange = 'visibilitychange';
    } else if (typeof document.mozHidden !== 'undefined') {
      hidden = 'mozHidden';
      visibilityChange = 'mozvisibilitychange';
    } else if (typeof document.msHidden !== 'undefined') {
      hidden = 'msHidden';
      visibilityChange = 'msvisibilitychange';
    } else if (typeof document.webkitHidden !== 'undefined') {
      hidden = 'webkitHidden';
      visibilityChange = 'webkitvisibilitychange';
    }

    document.addEventListener(visibilityChange, function visibilityChanged () {
      var prevHidden = client.documentHidden;
      client.documentHidden = document[hidden];

      if (prevHidden && !client.documentHidden) {
        console.info('Document now visible, updating - ' + new Date());
        refreshChart(true);
      }
    });
  })();

  window.onresize = refreshChart;

  updateClock();
  updateTimeAgoSoon();

  function Dropdown (el) {
    this.ddmenuitem = 0;

    this.$el = $(el);
    var that = this;

    $(document).click(function() { that.close(); });
  }
  Dropdown.prototype.close = function() {
    if (this.ddmenuitem) {
      this.ddmenuitem.css('visibility', 'hidden');
      this.ddmenuitem = 0;
    }
  };
  Dropdown.prototype.open = function(e) {
    this.close();
    this.ddmenuitem = $(this.$el).css('visibility', 'visible');
    e.stopPropagation();
  };

  var silenceDropdown = new Dropdown('#silenceBtn');
  var viewDropdown = new Dropdown('#viewMenu');

  $('.bgButton').click(function(e) {
    if (alarmingNow()) {
      silenceDropdown.open(e);
    }
  });

  $('.focus-range li').click(function(e) {
    var li = $(e.target);
    if (li.attr('data-hours')) {
      $('.focus-range li').removeClass('selected');
      li.addClass('selected');
      var hours = Number(li.data('hours'));
      client.focusRangeMS = times.hours(hours).msecs;
      Storages.localStorage.set('focusHours', hours);
      refreshChart();
    } else {
      viewDropdown.open(e);
    }
  });

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // Client-side code to connect to server and handle incoming data
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // eslint-disable-next-line no-undef
  client.socket = socket = io.connect();

  socket.on('dataUpdate', dataUpdate);

  function resetRetro () {
    client.retro = {
      loadedMills: 0
      , loadStartedMills: 0
    };
  }

  client.resetRetroIfNeeded = function resetRetroIfNeeded () {
    if (client.retro.loadedMills > 0 && Date.now() - client.retro.loadedMills > times.mins(5).msecs) {
      resetRetro();
      console.info('Cleared retro data to free memory');
    }
  };

  resetRetro();

  client.loadRetroIfNeeded = function loadRetroIfNeeded () {
    var now = Date.now();
    if (now - client.retro.loadStartedMills < times.secs(30).msecs) {
      console.info('retro already loading, started', new Date(client.retro.loadStartedMills));
      return;
    }

    if (now - client.retro.loadedMills > times.mins(3).msecs) {
      client.retro.loadStartedMills = now;
      console.info('retro not fresh load started', new Date(client.retro.loadStartedMills));
      socket.emit('loadRetro', {
        loadedMills: client.retro.loadedMills
      });
    }
  };

  socket.on('retroUpdate', function retroUpdate (retroData) {
    console.info('got retroUpdate', retroData, new Date(client.now));
    client.retro = {
      loadedMills: Date.now()
      , loadStartedMills: 0
      , data: retroData
    };
  });

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // Alarms and Text handling
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


  client.authorizeSocket = function authorizeSocket() {

    console.log('Authorizing socket');
    var auth_data = {
      client: 'web'
      , secret: client.authorized && client.authorized.token ? null : client.hashauth.hash()
      , token: client.authorized && client.authorized.token
      , history: history
    };

    socket.emit(
      'authorize'
      , auth_data
      , function authCallback (data) {

        console.log('Socket auth response', data);

        if (!data) {
          console.log('Crashed!');
          client.crashed();
        }

        if (!data.read || !hasRequiredPermission()) {
          client.hashauth.requestAuthentication(function afterRequest () {
            client.hashauth.updateSocketAuth();
            if (callback) {
              callback();
            }
          });
        } else if (callback) {
          callback();
        }
      }
    );
  }

  socket.on('connect', function() {
    console.log('Client connected to server.');
    client.authorizeSocket();
  });

  function hasRequiredPermission () {
    if (client.requiredPermission) {
      if (client.hashauth && client.hashauth.isAuthenticated()) {
        return true;
      } else {
        return client.authorized && client.authorized.check(client.requiredPermission);
      }
    } else {
      return true;
    }
  }

  //with predicted alarms, latestSGV may still be in target so to see if the alarm
  //  is for a HIGH we can only check if it's >= the bottom of the target
  function isAlarmForHigh () {
    return client.latestSGV && client.latestSGV.mgdl >= client.settings.thresholds.bgTargetBottom;
  }

  //with predicted alarms, latestSGV may still be in target so to see if the alarm
  //  is for a LOW we can only check if it's <= the top of the target
  function isAlarmForLow () {
    return client.latestSGV && client.latestSGV.mgdl <= client.settings.thresholds.bgTargetTop;
  }

  socket.on('notification', function(notify) {
    console.log('notification from server:', notify);

    if (notify.timestamp && previousNotifyTimestamp !== notify.timestamp) {
      previousNotifyTimestamp = notify.timestamp;
      client.plugins.visualizeAlarm(client.sbx, notify, notify.title + ' ' + notify.message);
    } else {
      console.log('No timestamp found for notify, not passing to plugins');
    }
  });

  socket.on('announcement', function(notify) {
    console.info('announcement received from server');
    console.log('notify:', notify);
    currentAnnouncement = notify;
    currentAnnouncement.received = Date.now();
    updateTitle();
  });

  socket.on('alarm', function(notify) {
    console.info('alarm received from server');
    console.log('notify:', notify);
    var enabled = (isAlarmForHigh() && client.settings.alarmHigh) || (isAlarmForLow() && client.settings.alarmLow);
    if (enabled) {
      console.log('Alarm raised!');
      generateAlarm(alarmSound, notify);
    } else {
      console.info('alarm was disabled locally', client.latestSGV.mgdl, client.settings);
    }
    chart.update(false);
  });

  socket.on('urgent_alarm', function(notify) {
    console.info('urgent alarm received from server');
    console.log('notify:', notify);

    var enabled = (isAlarmForHigh() && client.settings.alarmUrgentHigh) || (isAlarmForLow() && client.settings.alarmUrgentLow);
    if (enabled) {
      console.log('Urgent alarm raised!');
      generateAlarm(urgentAlarmSound, notify);
    } else {
      console.info('urgent alarm was disabled locally', client.latestSGV.mgdl, client.settings);
    }
    chart.update(false);
  });

  socket.on('clear_alarm', function(notify) {
    console.info('got clear_alarm', notify);
    if (alarmInProgress) {
      console.log('clearing alarm');
      stopAlarm(false, null, notify);
    }
  });

  $('#testAlarms').click(function(event) {

    // Speech synthesis also requires on iOS that user triggers a speech event for it to speak anything
    if (client.plugins('speech').isEnabled) {
      var msg = new SpeechSynthesisUtterance('Ok ok.');
      msg.lang = 'en-US';
      window.speechSynthesis.speak(msg);
    }

    d3.selectAll('.audio.alarms audio').each(function() {
      var audio = this;
      playAlarm(audio);
      setTimeout(function() {
        audio.pause();
      }, 4000);
    });
    event.preventDefault();
  });

  if (serverSettings) {
    $('.appName').text(serverSettings.name);
    $('.version').text(serverSettings.version);
    $('.head').text(serverSettings.head);
    if (serverSettings.apiEnabled) {
      $('.serverSettings').show();
    }
  }

  // hide food control if not enabled
  $('.foodcontrol').toggle(client.settings.enable.indexOf('food') > -1);
  // hide cob control if not enabled
  $('.cobcontrol').toggle(client.settings.enable.indexOf('cob') > -1);
  container.toggleClass('has-minor-pills', client.plugins.hasShownType('pill-minor', client.settings));

  function prepareEntries () {
    // Post processing after data is in
    var temp1 = [];
    var sbx = client.sbx.withExtendedSettings(client.rawbg);

    if (client.ddata.cal && client.rawbg.isEnabled(sbx)) {
      temp1 = client.ddata.sgvs.map(function(entry) {
        var rawbgValue = client.rawbg.showRawBGs(entry.mgdl, entry.noise, client.ddata.cal, sbx) ? client.rawbg.calc(entry, client.ddata.cal, sbx) : 0;
        if (rawbgValue > 0) {
          return { mills: entry.mills - 2000, mgdl: rawbgValue, color: 'white', type: 'rawbg' };
        } else {
          return null;
        }
      }).filter(function(entry) {
        return entry !== null;
      });
    }
    var temp2 = client.ddata.sgvs.map(function(obj) {
      return { mills: obj.mills, mgdl: obj.mgdl, direction: obj.direction, color: sgvToColor(obj.mgdl), type: 'sgv', noise: obj.noise, filtered: obj.filtered, unfiltered: obj.unfiltered };
    });
    client.entries = [];
    client.entries = client.entries.concat(temp1, temp2);

    client.entries = client.entries.concat(client.ddata.mbgs.map(function(obj) {
      return { mills: obj.mills, mgdl: obj.mgdl, color: 'red', type: 'mbg', device: obj.device };
    }));

    var tooOld = client.now - times.hours(48).msecs;
    client.entries = _.filter(client.entries, function notTooOld (entry) {
      return entry.mills > tooOld;
    });

    client.entries.forEach(function(point) {
      if (point.mgdl < 39) {
        point.color = 'transparent';
      }
    });

    client.entries.sort(function sorter (a, b) {
      return a.mills - b.mills;
    });
  }

  function dataUpdate (received, headless) {
    console.info('got dataUpdate', new Date(client.now));

    var lastUpdated = Date.now();
    receiveDData(received, client.ddata, client.settings);

    // Resend new treatments to profile
    client.profilefunctions.updateTreatments(client.ddata.profileTreatments, client.ddata.tempbasalTreatments, client.ddata.combobolusTreatments);

    if (received.profiles) {
      profile.loadData(received.profiles);
    }

    if (client.ddata.sgvs) {
      // TODO change the next line so that it uses the prediction if the signal gets lost (max 1/2 hr)
      client.ctx.data.lastUpdated = lastUpdated;
      client.latestSGV = client.ddata.sgvs[client.ddata.sgvs.length - 1];
    }

    client.ddata.inRetroMode = false;
    client.ddata.profile = profile;

    client.nowSBX = sandbox.clientInit(
      client.ctx
      , lastUpdated
      , client.ddata
    );

    //all enabled plugins get a chance to set properties, even if they aren't shown
    client.plugins.setProperties(client.nowSBX);

    prepareEntries();
    updateTitle();

    // Don't invoke D3 in headless mode

    if (headless) return;

    if (!isInitialData) {
      isInitialData = true;
      chart = client.chart = require('./chart')(client, d3, $);
      chart.update(true);
      brushed();
      chart.update(false);
    } else if (!inRetroMode()) {
      brushed();
      chart.update(false);
    } else {
      chart.updateContext();
    }
  }
};

module.exports = client;
