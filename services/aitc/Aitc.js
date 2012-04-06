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
 * The Original Code is Weave.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dan Mills <thunder@mozilla.com>
 *  Philipp von Weitershausen <philipp@weitershausen.de>
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

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

const TEST_TOKEN = {
  "api_endpoint": "https://dev-aitc1.services.mozilla.com/1.0/42",
  "id": "eyJleHBpcmVzIjogMTM2NTAxMDg5OC4xMTk1MDk5LCAic2FsdCI6ICI1YTE3ZDYiLCAidWlkIjogNDJ9L7vI7dWORWRocv_flcwuxr59yxs=",
  "key": "qTZf4ZFpAMpMoeSsX3zVRjiqmNs=",
  "uid": 42
};

function AitcService() {
  this.wrappedJSObject = this;
}
AitcService.prototype = {
  classID: Components.ID("{a3d387ca-fd26-44ca-93be-adb5fda5a78d}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference]),

  client: null,

  observe: function _observe(subject, topic, data) {
    switch (topic) {
    case "app-startup":
      let os = Cc["@mozilla.org/observer-service;1"].
               getService(Ci.nsIObserverService);
      os.addObserver(this, "final-ui-startup", true);
      break;
    case "final-ui-startup":
      dump("!!! AITC !!! final-ui-startup!\n");
      // Start AITC service after 5000ms
      this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      let self = this;
      this.timer.initWithCallback({
        notify: function() {
          Cu.import("resource://services-aitc/main.js");
          Cu.import("resource://services-aitc/aitcclient.js");
          self.client = new AitcClient(TEST_TOKEN);
          self.client.runPeriodically();
          dump("!!! AITC !!! SERVICE LOADED!\n");
          dump("!!! AITC !!! client: " + self.client + "\n");
        }
      }, 5000, Ci.nsITimer.TYPE_ONE_SHOT);
      break;
    }
  }
};

const components = [AitcService];
const NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
