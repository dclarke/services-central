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
 * The Original Code is Firefox Sync.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Philipp von Weitershausen <philipp@weitershausen.de>
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

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

const EXPORTED_SYMBOLS = ["GlobalSession"];

Cu.import("resource://services-sync/status.js");

let MetaGlobal = {

  _record: null,

  modified: false,
  isNew: false,

  fetch: function fetch(callback) {
    if (this._record) {
      callback(null, _record);
      return;
    }
    new SyncStorageRequest(Service.metaURL, function (error, response) {
      //TODO writeme
    });
  },

  store: function store(callback) {
    //TODO write me
  },

  clear: function clear() {
    this._record = null;
  },

  _ensureRecord: function _ensureRecord() {
    if (!this._record) {
      this._record = {};
      this.isNew = true;
    }
  },

  get syncID() {
    return this._record.syncID;
  },
  set syncID(value) {
    this._ensureRecord();
    this._record.syncID = value;
  }
  get storageVersion() {
    return this._record.storageVersion;
  },
  set storageVersion(value) {
    this._ensureRecord();
    this._record.storageVersion = value;
  }
  get engines() {
    return this._record.engines;
  },
  set engines(value) {
    this._ensureRecord();
    this._record.engines = value;
  }

  toSJON: function toJSON() {
    return {syncID:         this.syncID,
            storageVersion: this.storageVersion,
            engines:        this.engines};
  }

};

const SYNC_STATUS_OK             = 0;
const SYNC_STATUS_NO_CREDENTIALS = 1;

/**
 * Create a new Sync session tied to specific global state.
 *
 * The global state instance is a XXX
 * TODO
 */
function GlobalSession(globalState) {
  this.globalState = globalState;
}
GlobalSession.prototype = {
  /**
   * Defines the order of the functions called on the local object during a
   * sync.
   */
  STATE_FLOW: [
    "checkPreconditions",
    "obtainClusterURL",
    "fetchInfoCollections",
    "ensureSpecialRecords",
    "updateEngineTimestamps",
    "syncClientsEngine",
    "processFirstSyncPref",
    "processClientCommands",
    "updateEnabledEngines",
    "syncEngines"
  ],

  /**
   * Holds the current index in STATE_FLOW the session is operating in.
   */
  currentStateIndex: 0,

  inProgress: false,

  /**
   * Callback invoked when sync attempt has finished, regardless of success or
   * failure.
   */
  finishedCallback: null,

  advanceSyncState: function advanceSyncState() {
    // We are on the last state and are thus done.
    if (this.currentStateIndex == this.STATE_FLOW.length - 1) {
      this.currentStateIndex = 0;
      return;
    }

    this.currentStateIndex += 1;

    let f = this[STATE_FLOW[this.currentStateIndex]];
    f.call(this);
  },

  /**
   * Begin a sync.
   *
   * The caller should ensure that only one GlobalSession's begin() function
   * is active at one time.
   */
  begin: function begin(callback) {
    this.finishedCallback = callback;
    this.inProgress = true;

    // TODO move to state function
    Status.resetSync();

    this.advanceSyncState();
  },

  /**
   * Helper function called whenever the sync process finishes.
   *
   * @param  error
   *         Error code (eventually object) to be passed to callback which is
   *         defined on sync start.
   */
  finish: function finish(error) {
    this.inProgress = false;
    this.finishedCallback(error);
  },

  // --------------------------------------------------------------------------
  // What follows are the handlers for specific states during an individual   |
  // sync. They are defined in the order in which they are executed.          |
  // --------------------------------------------------------------------------

  checkPreconditions: function checkPreconditions() {
    let status = Status.checkSetup();

    if (status == CLIENT_NOT_CONFIGURED) {
      return this.finish(SYNC_STATUS_NO_CREDENTIALS);
    }

    // TODO do we have a first sync
    // TODO are we online
    // TODO have we met backoff
    // TODO master password unlocked

    this.advanceSyncState();
  },

  obtainClusterURL: function obtainClusterURL() {
    // TODO if we don't, fetch it
    // TODO if we can't, abort
    // See Service._findCluster()

    return this.advanceSyncState();
  },

  fetchInfoCollections: function fetchInfoCollections() {
    // This serves multiple purposes:
    // 1) Ensure our login credentials are valid
    // 2) Obtain initial/bootstrap data from the server

    // If we can't make the HTTP request, something is seriously wrong and
    // we can't proceed.

    // TODO use ?v=<version> once a day (if we still need that for metrics)

    return this.advanceSyncState();
  },

  ensureSpecialRecords: function ensureSpecialRecords() {
    // - fetch keys if 'crypto' timestamp differs from local one
    //   - if it's non-existent, goto fresh start.
    //   - decrypt keys with Sync Key, abort if HMAC verification fails.
    // - fetch meta/global if 'meta' timestamp differs from local one
    //   - if it's non-existent, goto fresh start.
    //   - check for storage version. if server data outdated, goto fresh start.
    //     if client is outdated, abort with friendly error message.
    //   - if syncID mismatch, reset local timestamps, refetch keys
    // - if fresh start:
    //   - wipe server. all of it.
    //   - create + upload meta/global
    //   - generate + upload new keys
    return this.advanceSyncState();
  },

  updateEngineTimestamps: function updateEngineTimestamps() {
    // - update engine last modified timestamps from info/collections record
    return this.advanceSyncState();
  },

  syncClientsEngine: function syncClientsEngine() {
    // clients engine always fetches all records
    return this.advanceSyncState();
  },

  processFirstSyncPref: function processFirstSyncPref() {
    // process reset/wipe requests in 'firstSync' preference
    return this.advanceSyncState();
  },

  processClientCommands: function processClientCommands() {
    // includes wipeClient commands, et al
    return this.advanceSyncState();
  },

  updateEnabledEngines: function updateEnabledEngines() {
    // infer enabled engines from meta/global
    return this.advanceSyncState();
  },

  syncEngines: function syncEngines() {
    // only stop if 401 seen
    return this.advanceSyncState();
  }
};
