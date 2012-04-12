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
 * The Original Code is Apps in the Cloud.
 *
 * The Initial Developer of the Original Code is the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2012.
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
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

const EXPORTED_SYMBOLS = ["Aitc"];
const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

// Switch to https://dev-token.services.mozilla.com when it is safe
// Make into prefs?
const DASHBOARD = "https://myapps.mozillalabs.com";
const MARKETPLACE = "https://marketplace.mozilla.org";
const TOKEN_SERVER = "http://token2.reg.mtv1.dev.svc.mozilla.com";

Cu.import("resource://gre/modules/Webapps.jsm");
Cu.import("resource://gre/modules/Services.jsm");

Cu.import("resource://services-sync/util.js");
Cu.import("resource://services-aitc/client.js");
Cu.import("resource://services-aitc/browserid.js");
Cu.import("resource://services-common/tokenserverclient.js");

// TODO: get rid of dump()s.
function AitcSvc() {
  this._token = null;
  this._client = null;
  dump("!!! AITC !!! Service initialized\n");
}
AitcSvc.prototype = {
  // Obtain a token from Sagrada token server
  getToken: function(assertion, cb) {
    let url = TOKEN_SERVER + "/1.0/aitc/1.0";
    let client = new TokenServerClient();

    client.getTokenFromBrowserIDAssertion(url, assertion, function(err, tok) {
      if (!err) {
        dump("!!! AITC !!! Got token " + JSON.stringify(tok) + "\n");
        cb(tok);
      } else {
        if (!err.response) {
          dump("!!! AITC !!! Error while fetching token " + err + "\n");
          return;
        }
        if (!err.response.success) {
          dump("!!! AITC !!! Non-200 while fetching token " + err.response.status + " :: " + err.response.body + "\n");
          return;
        }
        dump("!!! AITC !!! Got error " + err + "\n");
      }
    });
  },

  // To start the AitcClient we need a token, for which we need a BrowserID assertion.
  // If 'login' is true, makeClient will ask the user to login in the context of 'win'.
  // If 'login' is true, 'win' must be provided (win is a XUL Window object).
  makeClient: function(cb, login, win) {
    let self = this;
    if (self._client) {
      dump("!!! AITC client already exists, not creating!\n");
      return;
    }

    function gotAssertion(err, val) {
      if (err) {
        dump("!!! AITC error from getAssertion: " + err + "\n");
        cb(false);
      } else {
        self.getToken(val, function(token) {
          self._client = new AitcClient(token);
          cb(true);
        });
      }
    }

    BrowserID.isLoggedIn(function(yes) {
      if (!yes) {
        if (login) {
          // User is not logged in, create popup asking for login
          if (!win) {
            dump("!!! AITC login is true but no window!\n");
            cb(false);
          } else {
            // If the user hasn't logged in yet, there is no point in checking
            // getEmailForAudience since it will definitely be empty.
            if (win.document && win.document.readyState == "complete") {
              // This is the tabswitch case
              BrowserID.getAssertionWithLogin(win, gotAssertion);
            } else {
              // This is the tabload case
              win.addEventListener("load", function() {
                win.removeEventListener("load", arguments.callee, false);
                BrowserID.getAssertionWithLogin(win, gotAssertion);
              }, false);
            }
          }
        } else {
          dump("!!! AITC makeClient called but user not logged in!\n");
          cb(false);
        }
      } else {
        // User is logged in, obtain assertion for the same email that was used
        // to login to MARKETPLACE, if possible.
        BrowserID.getEmailForAudience(MARKETPLACE, function(email) {
          BrowserID.getAssertion(email, DASHBOARD, gotAssertion);
        });
      }
    });
  },

  // The goal of the init function is to be ready to activate the AITC
  // client whenever the user is looking at the dashboard
  init: function() {
    let self = this;

    // This is called iff the user is currently looking the dashboard
    function dashboardLoaded(browser) {
      dump("!!! OMG DASHBOARD !!!\n");
      if (self._client) {
        self._client.runPeriodically();
      } else {
        self.makeClient(function(yes) {
          if (yes) self._client.runPeriodically();
          else dump("!!! AITC CLIENT NOT CREATED :( !!!\n");
        }, true, browser.contentWindow);
      }
    }
    // This is called when the user's attention is elsewhere
    function dashboardUnloaded() {
      dump("!!! OMG no more dashboard !!!\n");
      if (self._client) self._client.stop();
    }

    // Called when a URI is loaded in any tab. We have to listen for this
    // because tabSelected is not called if I open a new tab which loads
    // about:home and then navigate to the dashboard, or navigation via
    // links on the currently open tab
    let listener = {
      onLocationChange: function(browser, progress, req, location, flags) {
        let win = Services.wm.getMostRecentWindow("navigator:browser");
        if (win.gBrowser.selectedBrowser == browser) {
          let uri = location.spec.substring(0, DASHBOARD.length);
          if (uri == DASHBOARD) dashboardLoaded(browser);
        }
      }
    };
    // Called when the current tab selection changes
    function tabSelected(event) {
      let browser = event.target.linkedBrowser;
      let uri = browser.currentURI.spec.substring(0, DASHBOARD.length);
      if (uri == DASHBOARD) dashboardLoaded(browser);
      else dashboardUnloaded();
    }

    // Add listeners for all windows opened in the future
    function winWatcher(subject, topic) {
      if (topic != "domwindowopened") return;
      subject.addEventListener("load", function() {
        subject.removeEventListener("load", arguments.callee, false);
        let doc = subject.document.documentElement;
        if (doc.getAttribute("windowtype") == "navigator:browser") {
          let browser = subject.gBrowser;
          browser.addTabsProgressListener(listener);
          browser.tabContainer.addEventListener("TabSelect", tabSelected);
        }
      }, false);
    }
    Services.ww.registerNotification(winWatcher);

    // Add listeners for all current open windows
    let enumerator = Services.wm.getEnumerator("navigator:browser");
    while (enumerator.hasMoreElements()) {
      let browser = enumerator.getNext().gBrowser;
      browser.addTabsProgressListener(listener);
      browser.tabContainer.addEventListener("TabSelect", tabSelected);

      // Also check the currently open URI
      let uri = browser.contentDocument.location.toString().substring(0, DASHBOARD.length);
      if (uri == DASHBOARD) dashboardLoaded(browser);
    }

    // Add listeners for app installs/uninstall
    Svc.Obs.add("webapps-sync-install", this);
    Svc.Obs.add("webapps-sync-uninstall", this);
  },

  observe: function(aSubject, aTopic, aData) {
    let self = this;

    switch (aTopic) {
    case "webapps-sync-install":
      dump("!!! AITC !!! app " + aData + " was installed\n");
      if (self._client) {
        self._client.remoteInstall(aData);
      } else {
        // Don't force a login if the user isn't already
        self.makeClient(function(yes) {
          if (yes) self._client.remoteInstall(aData);
        }, false);
      }
      break;
    case "webapps-sync-uninstall":
      dump("!!! AITC !!! app " + aData + " was uninstalled\n");
      //TODO: implement uninstall in client.js
      //if (this._client) this._client.remoteUninstall(aData);
      break;
    }
  }
};

let Aitc = new AitcSvc();
Aitc.init();
