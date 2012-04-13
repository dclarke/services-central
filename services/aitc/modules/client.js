/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is AitC Client
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2012
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Ian Bicking <ianb@mozilla.com>
 *  Anant Narayanan <anant@kix.in>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

const FREQ = 10000;
const EXPORTED_SYMBOLS = ['AitcClient'];
const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-common/rest.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://gre/modules/Webapps.jsm");

function AuthRESTRequest(uri, authToken) {
  RESTRequest.call(this, uri);
  this.authToken = authToken;
  this._log.level = 30;
  this._log.appenders.push(new Log4Moz.DumpAppender());
}
AuthRESTRequest.prototype = {
  __proto__: RESTRequest.prototype,
  dispatch: function(method, data, onComplete, onProgress) {
    let sig = Utils.computeHTTPMACSHA1(
      this.authToken.id,
      this.authToken.key,
      method,
      this.uri,
      {}
    );
    this.setHeader("Authorization", sig.getHeader());
    dump("!! Complete request: " + method + " " + this.uri.asciiSpec + "\n");
    RESTRequest.prototype.dispatch.call(this, method, data, function (error) {
      dump("!! Request result: " + this.uri.asciiSpec + " status: " + this.response.status + " bodylength: " + this.response.body.length + "\n");
      onComplete(error);
    }, onProgress);
  }
};

function AitcClient(token, registry) {
  this.uri = token.endpoint.replace(/\/+$/, '');
  dump('!!! AITC !!! token endpoint: ' + this.uri + '\n');
  this.token = token;
  this.registry = registry || DOMApplicationRegistry;

  // FIXME: should this be handled by the caller?
  this.appsLastModified = null;
  this.devicesLastModified = null;
  dump('!!! AITC !!! initialized client\n');
}
AitcClient.prototype = {
  _log: null,
  _timer: null,
  _putInProgress: false,

  _error: function(req) {
    dump("!!! AITC !!! Error for request: " + req.response.status + " :: " + req.response.body + "\n");
  },

  _makeRequest: function(uri) {
    if (typeof uri != 'string') {
      throw 'Bad request URI: ' + uri;
    }
    return new AuthRESTRequest(uri, this.token);
  },

  _makeAppURI: function(origin) {
    let part = btoa(Utils._sha1(origin)).replace(/\+/, '-').replace(/\//, '_').replace(/=/, '');
    return this.uri + '/apps/' + part;
  },

  getApps: function(cb) {
    let self = this;
    // If there's a unfinished PUT, just bail
    if (self._putInProgress) {
      cb("AITC: PUT in progress, aborting GET!");
      dump("!!! AITC !!! GET schedules but aborting due to outstanding PUT!\n");
      return;
    }

    let req = this._makeRequest(this.uri + '/apps/?full=1');
    if (this.appsLastModified) {
      req.setHeader("X-If-Modified-Since", this.appsLastModified);
    }
    req.get(function (error) {
      if (error) {
        cb(error);
        dump("!!! AITC !!! Got from getApps error " + error + "\n");
        return;
      }
      if (req.response.status == 304) {
        cb(null, null);
        dump("!!! AITC !!! Got from getApps 304\n");
        return;
      }
      if (req.response.status == 200) {
        dump("!!! AITC !!! Got from getApps: " + req.response.body + " :: " + req.response.body.length + "\n");
        let tmp = JSON.parse(req.response.body);
        cb(null, tmp["apps"]);
        self.appsLastModified = parseInt(req.response.headers['x-timestamp']);
      } else {
        self._error(req);
      }
    });
  },

  putApp: function(appRec, appLastModified, cb) {
    let self = this;

    // Don't do any GETs until this PUT finishes!
    self._putInProgress = true;

    let uri = this._makeAppURI(appRec.origin);
    let req = this._makeRequest(uri);
    if (appLastModified) {
      req.setHeader('X-If-Unmodified-Since', appLastModified);
    }

    dump("!!! AITC !!! Calling putApp with " + JSON.stringify(appRec) + "\n");
    req.put(JSON.stringify(appRec), function (error) {
      if (error) {
        cb(error);
        dump("!!! AITC !!! Got from putApp error " + error + "\n");
        return;
      }
      if (req.response.status == 412) {
        dump("!!! AITC !!! Got from putApp 412\n");
        cb({preconditionFailed: true});
        return;
      } else if (req.response.status != 201 && req.response.status != 204) {
        self._error(req);
        return;
      }

      dump("!!! AITC !!! Got from putApp: " + req.response.body + " :: " + req.response.body.length + "\n");
      cb();
      self._putInProgress = false;
    });
  },

  remoteInstall: function(app) {
    dump("!!! AITC !!! putting app: " + app.origin + "\n");
    // We need to sanitize the app record a bit to match what the server expects
    // manifestURL -> manifestPath (this could probalby be changed in registry)
    // We don't store manifests on the server
    let record = {
      origin: app.origin,
      installOrigin: app.installOrigin,
      manifestPath: app.manifestURL,
      receipts: app.receipts
    };

    if ('installedAt' in app)
      record.installedAt = app.installedAt;
    if ('modifiedAt' in app)
      record.modifiedAt = app.modifiedAt;

    this.putApp(record, null, function (error) {});
  },

  processResponse: function(resp, callback) {
    let self = this;
    let allApps = DOMApplicationRegistry.getAllWithoutManifests(function (apps) {
      let existingByOrigin = {};
      let originToId = {};
      let toDelete = {};
      let commands = [];

      // These are all the local apps
      for (let i in apps) {
        originToId[apps[i].origin] = i;
        existingByOrigin[apps[i].origin] = toDelete[apps[i].origin] = apps[i];
      }

      // Iterate over remote apps
      for (let i=0; i<resp.length; i++) {
        // Don't delete apps that are both local & remote
        let origin = resp[i].origin;
        delete toDelete[origin];

        // If there is a remote app that isn't local or if the remote app was installed later
        if ((!(origin in existingByOrigin)) || existingByOrigin[origin].installTime < resp[i].installTime) {
          let id = originToId[origin] || DOMApplicationRegistry.makeAppId();

          // Remap back to format expected by DOMApplicationRegistry
          let realVal = {
            origin: resp[i].origin,
            installOrigin: resp[i].installOrigin,
            installedAt: resp[i].installedAt,
            modifiedAt: resp[i].modifiedAt,
            manifestURL: resp[i].manifestPath,
            receipts: resp[i].receipts
          };
          let record = {id: id, value: realVal};
          commands.push(record);
        }
      }

      // Update manifests for all the commands (new remote apps) we have so far
      let done = 0;
      let finalCommands = [];
      let toUpdate = commands.length;

      // Copied from Webapps.js, refactor into common?
      function checkManifest(aManifest, aInstallOrigin) {
        // TODO : check for install_allowed_from
        if (aManifest.name == undefined)
          return false;

        if (aManifest.installs_allowed_from) {
          let ok = false;
          aManifest.installs_allowed_from.forEach(function(aOrigin) {
            if (aOrigin == "*" || aOrigin == aInstallOrigin)
              ok = true;
          });
          return ok;
        }
        return true;
      }

      function finishedFetching(num) {
        if (num == toUpdate) {
          for (let i in toDelete) {
            finalCommands.push({id: originToId[i], deleted: true});
          }
          if (finalCommands.length) {
            dump("!!! AITC !!! finished fetching, calling DOMApplicationRegistry.updateApps\n");
            DOMApplicationRegistry.updateApps(finalCommands, callback);
          } else {
            dump("!!! AITC !!! finished fetching, no finalCommands\n");
            callback();
          }
        }
      }

      for (let j = 0; j < toUpdate; j++) {
        let app = commands[j];
        let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Ci.nsIXMLHttpRequest);

        let url = app.value.manifestURL;
        if (url[0] == "/") {
          url = app.value.origin + app.value.manifestURL;
        }

        dump("!!! AITC !!! going to get manifest " + url + "\n");
        try {
          xhr.open("GET", url, true);
          xhr.addEventListener("load", function() {
            if (xhr.status == 200) {
              let installOrigin = app.value.installOrigin;
              let manifest = JSON.parse(xhr.responseText, installOrigin);
              if (!checkManifest(manifest, installOrigin)) {
                // We'll get this app on the next round
              } else {
                app.value.manifest = manifest;
                finalCommands.push({id: app.id, value: app.value});
                dump("!!! AITC !!!! added to finalCommands " + app.id + "\n");
              }
            } else {
              // Not 200
              dump("!!! AITC !!! got non-200 while fetching manifest " + xhr.status + "\n");
            }

            // Am I last?
            done += 1;
            finishedFetching(done);
          }, false);
          xhr.addEventListener("error", function() {
            // Network error
            done += 1;
            finishedFetching(done);
          }, false);
          xhr.send(null);
        } catch (e) {
          dump("!!! AITC !!! Exception while fetching manifest " + e + "\n");
        }
      }
    });
  },

  checkServer: function() {
    let self = this;
    dump('!!! AITC !!! Starting server check\n');
    this.getApps(function (error, apps) {
      if (apps && !error) {
        dump('!!! AITC !!! got apps ' + apps.length + "\n");
        self.processResponse(apps, function () {
          dump('!!! saved result\n');
        });
      }
    });
  },

  runPeriodically: function() {
    let self = this;
    if (this._timer) return;

    // Do one check right now, and then once every FREQ seconds
    self.checkServer();
    this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    let event = {
      notify: function (timer) {
        self.checkServer();
      }
    };
    this._timer.initWithCallback(event, FREQ, Ci.nsITimer.TYPE_REPEATING_SLACK);
  },

  stop: function() {
    if (!this._timer) return;
    this._timer.cancel();
    this._timer = null;
  }

  /* Unused methods, will be utilized in subsequent patches...

  getAppDetails: function(since, cb) {
    let self = this;
    let uri = this.uri + '/apps/?full=1';
    if (since) {
      uri += '&after=' + encodeURIComponent(since);
    }
    let req = this._makeRequest(this.uri);
    req.get(function (error) {
      if (error) {
        cb(error);
        return;
      }
      if (req.response.status == 204) {
        cb(null, []);
        return;
      }
      if (req.response.status == 200) {
        cb(null, JSON.parse(req.response.body));
      } else {
        self._error(req);
      }
    });
  },

  deleteApp: function(origin, appLastModified, cb) {
    let self = this;
    let uri = this._makeAppURI(origin);
    let req = this._makeRequest(uri);
    if (appLastModified) {
      req.setHeader('X-If-Unmodified-Since', appLastModified);
    }
    req.delete(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 412) {
        cb({preconditionFailed: true});
        return;
      }
      cb();
    });
  },

  _validUUID: function(uuid) {
    return uuid.search(/^[a-zA-Z0-9_-]+$/) == 0;
  },

  _makeDeviceURI: function(deviceUUID) {
    if (! this._validUUID(deviceUUID)) {
      throw 'Not a valid UUID: ' + deviceUUID;
    }
    return this.uri + '/devices/' + deviceUUID;
  },

  getDevices: function(cb) {
    let self = this;
    let req = this._makeRequest(this.uri + '/devices/');
    if (this.devicesLastModified) {
      req.setHeader('X-If-Modified-Since', this.devicesLastModified);
    }
    req.get(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 304) {
        cb(null, null);
        return;
      }
      cb(null, JSON.parse(this.response.body));
    });
  },

  putDevice: function(data, lastModified, cb) {
    let self = this;
    let req = this._makeRequest(this._makeDeviceURI(data.uuid));
    if (lastModified) {
      req.setHeader('X-If-Unmodified-Since', lastModified);
    }
    req.put(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 412) {
        cb({preconditionFailed: true});
        return;
      }
      cb();
    });
  },

  deleteDevice: function(uuid, lastModified, cb) {
    let self = this;
    let req = this._makeRequest(this._makeDeviceURI(uuid));
    if (lastModified) {
      req.setHeader('X-If-Unmodified-Since', lastModified);
    }
    req.delete(function(error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      if (req.status == 412) {
        cb({preconditionFailed: true});
        return;
      }
      cb();
    });
  },

  deleteCollection: function(cb) {
    let self = this;
    let req = this._makeRequest(this.uri);
    req.delete(function (error) {
      if (error) {
        self.error(error);
        cb(error);
        return;
      }
      cb();
    });
  }
  */
};
