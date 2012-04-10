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
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Dan Mills <thunder@mozilla.com>
 *  Philipp von Weitershausen <philipp@weitershausen.de>
 *  Richard Newman <rnewman@mozilla.com>
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

const EXPORTED_SYMBOLS = ["WBORecord", "RecordManager", "Records",
                          "CryptoWrapper", "CollectionKeys", "Collection",
                          "MetaGlobalRecord"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const CRYPTO_COLLECTION = "crypto";
const KEYS_WBO = "keys";

Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/identity.js");
Cu.import("resource://services-sync/keys.js");
Cu.import("resource://services-common/log4moz.js");
Cu.import("resource://services-sync/resource.js");
Cu.import("resource://services-sync/storageservice.js");
Cu.import("resource://services-sync/util.js");

function WBORecord(collection, id) {
  this.data = {};
  this.payload = {};
  this.collection = collection;      // Optional.
  this.id = id;                      // Optional.
}
WBORecord.prototype = {
  _logName: "Sync.Record.WBO",

  get modified() {
    return this.data.modified;
  },

  set modified(value) {
    Utils.ensureMillisecondsTimestamp(value);
    this.data.modified = value;
  },

  get sortindex() {
    if (this.data.sortindex)
      return this.data.sortindex;
    return 0;
  },

  // Get thyself from your URI, then deserialize.
  // Set thine 'response' field.
  fetch: function fetch(uri) {
    let r = new Resource(uri).get();
    if (r.success) {
      this.deserialize(r);   // Warning! Muffles exceptions!
    }
    this.response = r;
    return this;
  },

  upload: function upload(uri) {
    return new Resource(uri).put(this);
  },

  // Take a base URI string, with trailing slash, and return the URI of this
  // WBO based on collection and ID.
  uri: function(base) {
    if (this.collection && this.id) {
      let url = Utils.makeURI(base + this.collection + "/" + this.id);
      url.QueryInterface(Ci.nsIURL);
      return url;
    }
    return null;
  },

  deserialize: function deserialize(json) {
    this.data = json.constructor.toString() == String ? JSON.parse(json) : json;

    try {
      // The payload is likely to be JSON, but if not, keep it as a string
      this.payload = JSON.parse(this.payload);
    } catch(ex) {}
  },

  toJSON: function toJSON() {
    // Copy fields from data to be stringified, making sure payload is a string
    let obj = {};
    for (let [key, val] in Iterator(this.data))
      obj[key] = key == "payload" ? JSON.stringify(val) : val;
    if (this.ttl)
      obj.ttl = this.ttl;
    return obj;
  },

  toString: function toString() {
    return "{ " +
      "id: "       + this.id        + "  " +
      "index: "    + this.sortindex + "  " +
      "modified: " + this.modified  + "  " +
      "ttl: "      + this.ttl       + "  " +
      "payload: "  + JSON.stringify(this.payload) +
      " }";
  }
};

Utils.deferGetSet(WBORecord, "data", ["id", "sortindex", "payload"]);

XPCOMUtils.defineLazyGetter(this, "Records", function () {
  return new RecordManager();
});

function RecordManager() {
  this._log = Log4Moz.repository.getLogger(this._logName);
  this._records = {};
}
RecordManager.prototype = {
  _recordType: WBORecord,
  _logName: "Sync.RecordManager",

  import: function RecordMgr_import(url) {
    this._log.trace("Importing record: " + (url.spec ? url.spec : url));
    try {
      // Clear out the last response with empty object if GET fails
      this.response = {};
      this.response = new Resource(url).get();

      // Don't parse and save the record on failure
      if (!this.response.success)
        return null;

      let record = new this._recordType(url);
      record.deserialize(this.response);

      return this.set(url, record);
    } catch(ex) {
      this._log.debug("Failed to import record: " + Utils.exceptionStr(ex));
      return null;
    }
  },

  get: function RecordMgr_get(url) {
    // Use a url string as the key to the hash
    let spec = url.spec ? url.spec : url;
    if (spec in this._records)
      return this._records[spec];
    return this.import(url);
  },

  set: function RecordMgr_set(url, record) {
    let spec = url.spec ? url.spec : url;
    return this._records[spec] = record;
  },

  contains: function RecordMgr_contains(url) {
    if ((url.spec || url) in this._records)
      return true;
    return false;
  },

  clearCache: function recordMgr_clearCache() {
    this._records = {};
  },

  del: function RecordMgr_del(url) {
    delete this._records[url];
  }
};

function CryptoWrapper(collection, id) {
  this.cleartext = {};
  WBORecord.call(this, collection, id);
  this.ciphertext = null;
  this.id = id;
}
CryptoWrapper.prototype = {
  __proto__: WBORecord.prototype,
  _logName: "Sync.Record.CryptoWrapper",

  ciphertextHMAC: function ciphertextHMAC(keyBundle) {
    let hasher = keyBundle.sha256HMACHasher;
    if (!hasher) {
      throw "Cannot compute HMAC without an HMAC key.";
    }

    return Utils.bytesAsHex(Utils.digestUTF8(this.ciphertext, hasher));
  },

  /*
   * Don't directly use the sync key. Instead, grab a key for this
   * collection, which is decrypted with the sync key.
   *
   * Cache those keys; invalidate the cache if the time on the keys collection
   * changes, or other auth events occur.
   *
   * Optional key bundle overrides the collection key lookup.
   */
  encrypt: function encrypt(keyBundle) {
    keyBundle = keyBundle || CollectionKeys.keyForCollection(this.collection);
    if (!keyBundle) {
      throw new Error("Key bundle is null for " + this.uri.spec);
    }

    this.IV = Svc.Crypto.generateRandomIV();
    this.ciphertext = Svc.Crypto.encrypt(JSON.stringify(this.cleartext),
                                         keyBundle.encryptionKeyB64, this.IV);
    this.hmac = this.ciphertextHMAC(keyBundle);
    this.cleartext = null;
  },

  // Optional key bundle.
  decrypt: function decrypt(keyBundle) {
    if (!this.ciphertext) {
      throw "No ciphertext: nothing to decrypt?";
    }

    keyBundle = keyBundle || CollectionKeys.keyForCollection(this.collection);
    if (!keyBundle) {
      throw new Error("Key bundle is null for " + this.collection + "/" + this.id);
    }

    // Authenticate the encrypted blob with the expected HMAC
    let computedHMAC = this.ciphertextHMAC(keyBundle);

    if (computedHMAC != this.hmac) {
      Utils.throwHMACMismatch(this.hmac, computedHMAC);
    }

    // Handle invalid data here. Elsewhere we assume that cleartext is an object.
    let cleartext = Svc.Crypto.decrypt(this.ciphertext,
                                       keyBundle.encryptionKeyB64, this.IV);
    let json_result = JSON.parse(cleartext);

    if (json_result && (json_result instanceof Object)) {
      this.cleartext = json_result;
      this.ciphertext = null;
    } else {
      throw "Decryption failed: result is <" + json_result + ">, not an object.";
    }

    // Verify that the encrypted id matches the requested record's id.
    if (this.cleartext.id != this.id)
      throw "Record id mismatch: " + this.cleartext.id + " != " + this.id;

    return this.cleartext;
  },

  toString: function toString() {
    let payload = this.deleted ? "DELETED" : JSON.stringify(this.cleartext);

    return "{ " +
      "id: "         + this.id          + "  " +
      "index: "      + this.sortindex   + "  " +
      "modified: "   + this.modified    + "  " +
      "ttl: "        + this.ttl         + "  " +
      "payload: "    + payload          + "  " +
      "collection: " + (this.collection || "undefined") +
      " }";
  },

  // The custom setter below masks the parent's getter, so explicitly call it :(
  get id() WBORecord.prototype.__lookupGetter__("id").call(this),

  // Keep both plaintext and encrypted versions of the id to verify integrity
  set id(val) {
    WBORecord.prototype.__lookupSetter__("id").call(this, val);
    return this.cleartext.id = val;
  },
};

Utils.deferGetSet(CryptoWrapper, "payload", ["ciphertext", "IV", "hmac"]);
Utils.deferGetSet(CryptoWrapper, "cleartext", "deleted");

XPCOMUtils.defineLazyGetter(this, "CollectionKeys", function () {
  return new CollectionKeyManager();
});


/**
 * Keeps track of mappings between collection names ('tabs') and KeyBundles.
 *
 * You can update this thing simply by giving it /info/collections. It'll
 * use the last modified time to bring itself up to date.
 */
function CollectionKeyManager() {
  this.lastModified = 0;
  this._collections = {};
  this._default = null;

  this._log = Log4Moz.repository.getLogger("Sync.CollectionKeys");
}

// TODO: persist this locally as an Identity. Bug 610913.
// Note that the last modified time needs to be preserved.
CollectionKeyManager.prototype = {
  _lastModified: null,

  get lastModified() {
    return this._lastModified;
  },

  set lastModified(value) {
    Utils.ensureMillisecondsTimestamp(value);
    this._lastModified = value;
  },

  // Return information about old vs new keys:
  // * same: true if two collections are equal
  // * changed: an array of collection names that changed.
  _compareKeyBundleCollections: function _compareKeyBundleCollections(m1, m2) {
    let changed = [];

    function process(m1, m2) {
      for (let k1 in m1) {
        let v1 = m1[k1];
        let v2 = m2[k1];
        if (!(v1 && v2 && v1.equals(v2)))
          changed.push(k1);
      }
    }

    // Diffs both ways.
    process(m1, m2);
    process(m2, m1);

    // Return a sorted, unique array.
    changed.sort();
    let last;
    changed = [x for each (x in changed) if ((x != last) && (last = x))];
    return {same: changed.length == 0,
            changed: changed};
  },

  get isClear() {
   return !this._default;
  },

  clear: function clear() {
    this._log.info("Clearing CollectionKeys...");
    this.lastModified = 0;
    this._collections = {};
    this._default = null;
  },

  keyForCollection: function(collection) {
    if (collection && this._collections[collection])
      return this._collections[collection];

    return this._default;
  },

  /**
   * If `collections` (an array of strings) is provided, iterate
   * over it and generate random keys for each collection.
   * Create a WBO for the given data.
   */
  _makeWBO: function(collections, defaultBundle) {
    let wbo = new CryptoWrapper(CRYPTO_COLLECTION, KEYS_WBO);
    let c = {};
    for (let k in collections) {
      c[k] = collections[k].keyPairB64;
    }
    wbo.cleartext = {
      "default":     defaultBundle ? defaultBundle.keyPairB64 : null,
      "collections": c,
      "collection":  CRYPTO_COLLECTION,
      "id":          KEYS_WBO
    };
    return wbo;
  },

  /**
   * Create a WBO for the current keys.
   */
  asWBO: function(collection, id)
    this._makeWBO(this._collections, this._default),

  /**
   * Compute a new default key, and new keys for any specified collections.
   */
  newKeys: function(collections) {
    let newDefaultKey = new BulkKeyBundle(DEFAULT_KEYBUNDLE_NAME);
    newDefaultKey.generateRandom();

    let newColls = {};
    if (collections) {
      collections.forEach(function (c) {
        let b = new BulkKeyBundle(c);
        b.generateRandom();
        newColls[c] = b;
      });
    }
    return [newDefaultKey, newColls];
  },

  /**
   * Generates new keys, but does not replace our local copy. Use this to
   * verify an upload before storing.
   */
  generateNewKeysWBO: function(collections) {
    let newDefaultKey, newColls;
    [newDefaultKey, newColls] = this.newKeys(collections);

    return this._makeWBO(newColls, newDefaultKey);
  },

  // Take the fetched info/collections WBO, checking the change
  // time of the crypto collection.
  updateNeeded: function(info_collections) {

    this._log.info("Testing for updateNeeded. Last modified: " + this.lastModified);

    // No local record of modification time? Need an update.
    if (!this.lastModified)
      return true;

    // No keys on the server? We need an update, though our
    // update handling will be a little more drastic...
    if (!(CRYPTO_COLLECTION in info_collections))
      return true;

    // Otherwise, we need an update if our modification time is stale.
    return (info_collections[CRYPTO_COLLECTION] > this.lastModified);
  },

  //
  // Set our keys and modified time to the values fetched from the server.
  // Returns one of three values:
  //
  // * If the default key was modified, return true.
  // * If the default key was not modified, but per-collection keys were,
  //   return an array of such.
  // * Otherwise, return false -- we were up-to-date.
  //
  setContents: function setContents(payload, modified) {
    if (!modified) {
      throw new Error("No modified time provided to setContents.");
    }

    Utils.ensureMillisecondsTimestamp(modified);

    let self = this;

    this._log.info("Setting CollectionKeys contents. Our last modified: " +
                   this.lastModified + ", input modified: " + modified + ".");

    if (!payload)
      throw "No payload in CollectionKeys.setContents().";

    if (!payload.default) {
      this._log.warn("No downloaded default key: this should not occur.");
      this._log.warn("Not clearing local keys.");
      throw "No default key in CollectionKeys.setContents(). Cannot proceed.";
    }

    // Process the incoming default key.
    let b = new BulkKeyBundle(DEFAULT_KEYBUNDLE_NAME);
    b.keyPairB64 = payload.default;
    let newDefault = b;

    // Process the incoming collections.
    let newCollections = {};
    if ("collections" in payload) {
      this._log.info("Processing downloaded per-collection keys.");
      let colls = payload.collections;
      for (let k in colls) {
        let v = colls[k];
        if (v) {
          let keyObj = new BulkKeyBundle(k);
          keyObj.keyPairB64 = v;
          if (keyObj) {
            newCollections[k] = keyObj;
          }
        }
      }
    }

    // Check to see if these are already our keys.
    let sameDefault = (this._default && this._default.equals(newDefault));
    let collComparison = this._compareKeyBundleCollections(newCollections, this._collections);
    let sameColls = collComparison.same;

    if (sameDefault && sameColls) {
      self._log.info("New keys are the same as our old keys! Bumped local modified time.");
      self.lastModified = modified;
      return false;
    }

    // Make sure things are nice and tidy before we set.
    this.clear();

    this._log.info("Saving downloaded keys.");
    this._default     = newDefault;
    this._collections = newCollections;

    // Always trust the server.
    self._log.info("Bumping last modified to " + modified);
    self.lastModified = modified;

    return sameDefault ? collComparison.changed : true;
  },

  updateContents: function updateContents(syncKeyBundle, storage_keys) {
    let log = this._log;
    log.info("Updating collection keys...");

    // storage_keys is a WBO, fetched from storage/crypto/keys.
    // Its payload is the default key, and a map of collections to keys.
    // We lazily compute the key objects from the strings we're given.

    let payload;
    try {
      payload = storage_keys.decrypt(syncKeyBundle);
    } catch (ex) {
      log.warn("Got exception \"" + ex + "\" decrypting storage keys with sync key.");
      log.info("Aborting updateContents. Rethrowing.");
      throw ex;
    }

    let r = this.setContents(payload, storage_keys.modified);
    log.info("Collection keys updated.");
    return r;
  }
}

function Collection(uri, recordObj) {
  Resource.call(this, uri);
  this._recordObj = recordObj;

  this._full = false;
  this._ids = null;
  this._limit = 0;
  this._older = 0;
  this._newer = 0;
  this._data = [];
}
Collection.prototype = {
  __proto__: Resource.prototype,
  _logName: "Sync.Collection",

  _rebuildURL: function Coll__rebuildURL() {
    // XXX should consider what happens if it's not a URL...
    this.uri.QueryInterface(Ci.nsIURL);

    let args = [];
    if (this.older)
      args.push('older=' + this.older);
    else if (this.newer) {
      args.push('newer=' + this.newer);
    }
    if (this.full)
      args.push('full=1');
    if (this.sort)
      args.push('sort=' + this.sort);
    if (this.ids != null)
      args.push("ids=" + this.ids);
    if (this.limit > 0 && this.limit != Infinity)
      args.push("limit=" + this.limit);

    this.uri.query = (args.length > 0)? '?' + args.join('&') : '';
  },

  // get full items
  get full() { return this._full; },
  set full(value) {
    this._full = value;
    this._rebuildURL();
  },

  // Apply the action to a certain set of ids
  get ids() this._ids,
  set ids(value) {
    this._ids = value;
    this._rebuildURL();
  },

  // Limit how many records to get
  get limit() this._limit,
  set limit(value) {
    this._limit = value;
    this._rebuildURL();
  },

  // get only items modified before some date
  get older() { return this._older; },
  set older(value) {
    Utils.ensureMillisecondsTimestamp(value);
    this._older = value;
    this._rebuildURL();
  },

  // get only items modified since some date
  get newer() { return this._newer; },
  set newer(value) {
    Utils.ensureMillisecondsTimestamp(value);
    this._newer = value;
    this._rebuildURL();
  },

  // get items sorted by some criteria. valid values:
  // oldest (oldest first)
  // newest (newest first)
  // index
  get sort() { return this._sort; },
  set sort(value) {
    this._sort = value;
    this._rebuildURL();
  },

  pushData: function Coll_pushData(data) {
    this._data.push(data);
  },

  clearRecords: function Coll_clearRecords() {
    this._data = [];
  },

  set recordHandler(onRecord) {
    // Save this because onProgress is called with this as the ChannelListener
    let coll = this;

    // Switch to newline separated records for incremental parsing
    coll.setHeader("Accept", "application/newlines");

    this._onProgress = function() {
      let newline;
      while ((newline = this._data.indexOf("\n")) > 0) {
        // Split the json record from the rest of the data
        let json = this._data.slice(0, newline);
        this._data = this._data.slice(newline + 1);

        // Deserialize a record from json and give it to the callback
        let record = new coll._recordObj();
        record.deserialize(json);
        onRecord(record);
      }
    };
  }
};

/**
 * Representation of the special meta global record.
 *
 * The meta global record is a Basic Storage Object stored in the "meta"
 * collection with the id "global." This record stores global, unencrypted
 * metadata which is used to help configure the sync client.
 *
 * The meta global record stores the set of engines configured for the account.
 * Each engine record consists of a version and syncID.
 */
function MetaGlobalRecord() {
  BasicStorageObject.call(this, "global", "meta");

  this._metaglobal = {
    syncID:  null,
    storageVersion: null,
    engines: {},
  };
}
MetaGlobalRecord.prototype = {
  __proto__: BasicStorageObject.prototype,

  _metaglobal: null,

  /**
   * Global sync identifier.
   */
  get syncID() {
    return this._metaglobal.syncID;
  },

  set syncID(value) {
    this._metaglobal.syncID = value;
  },

  /**
   * The Sync storage format version.
   *
   * Sync clients periodically change their convention on how data is stored
   * in the storage service. The convention they agree on is defined by this
   * version identifier, which is an integer that increases with each new
   * version.
   */
  get storageVersion() {
    return this._metaglobal.storageVersion;
  },

  set storageVersion(value) {
    this._metaglobal.storageVersion = value;
  },

  get engines() {
    return this._metaglobal.engines;
  },

  set engines(value) {
    this._metaglobal.engines = value;
  },

  hasEngine: function hasEngine(name) {
    return name in this._metaglobal.engines;
  },

  getEngine: function getEngine(name) {
    return this._metaglobal.engines[name];
  },

  setEngine: function setEngine(name, version, syncID) {
    this._metaglobal.engines[name] = {
      version: version,
      syncID:  syncID
    };
  },

  deserialize: function deserialize(input) {
    BasicStorageObject.prototype.deserialize.call(this, input);

    this._metaglobal = JSON.parse(this.payload);
  },

  toJSON: function toJSON() {
    this._setPayload();

    return BasicStorageObject.prototype.toJSON.call(this);
  },

  toString: function toString() {
    this._setPayload();

    return BasicStorageObject.prototype.toString.call(this);
  },

  _setPayload: function _setPayload() {
    this.payload = JSON.stringify(this._metaglobal);
  },
};
