"use strict";

/**
 * Firestore en memoria con el subconjunto de API que usa el handler.
 * Permite probar el flujo completo sin emulador ni credenciales.
 */

class DocSnapshot {
  constructor(id, data, ref) {
    this.id = id;
    this.exists = data !== undefined && data !== null;
    this.ref = ref;
    this._data = data;
  }
  data() {
    return this._data;
  }
}

class DocRef {
  constructor(store, collectionName, id) {
    this.store = store;
    this.collectionName = collectionName;
    this.id = id;
  }
  _bucket() {
    if (!this.store.data[this.collectionName]) this.store.data[this.collectionName] = new Map();
    return this.store.data[this.collectionName];
  }
  async get() {
    return new DocSnapshot(this.id, this._bucket().get(this.id), this);
  }
  async set(value, options) {
    this.store.assertUp();
    const bucket = this._bucket();
    const previous = bucket.get(this.id);
    bucket.set(this.id, options && options.merge && previous ? Object.assign({}, previous, value) : Object.assign({}, value));
  }
  async update(value) {
    this.store.assertUp();
    const bucket = this._bucket();
    bucket.set(this.id, Object.assign({}, bucket.get(this.id) || {}, value));
  }
}

class Query {
  constructor(store, collectionName, filters = [], limitValue = 0) {
    this.store = store;
    this.collectionName = collectionName;
    this.filters = filters;
    this.limitValue = limitValue;
  }
  where(field, op, value) {
    return new Query(this.store, this.collectionName, this.filters.concat([{ field, op, value }]), this.limitValue);
  }
  limit(value) {
    return new Query(this.store, this.collectionName, this.filters, value);
  }
  async get() {
    this.store.assertUp();
    const bucket = this.store.data[this.collectionName] || new Map();
    let docs = [...bucket.entries()]
      .filter(([, value]) => this.filters.every((filter) => value[filter.field] === filter.value))
      .map(([id, value]) => new DocSnapshot(id, value, new DocRef(this.store, this.collectionName, id)));
    if (this.limitValue) docs = docs.slice(0, this.limitValue);
    return { empty: docs.length === 0, docs, size: docs.length };
  }
}

class CollectionRef extends Query {
  doc(id) {
    return new DocRef(this.store, this.collectionName, id || this.store.nextId());
  }
  async add(value) {
    this.store.assertUp();
    if (this.collectionName === this.store.failCollection) {
      throw new Error("write failed (simulado)");
    }
    const id = this.store.nextId();
    const ref = new DocRef(this.store, this.collectionName, id);
    await ref.set(value);
    return ref;
  }
}

class FirestoreStub {
  constructor() {
    this.data = {};
    this.counter = 0;
    this.down = false;
    this.failCollection = null;
  }
  nextId() {
    this.counter += 1;
    return `doc${this.counter}`;
  }
  assertUp() {
    if (this.down) throw new Error("firestore unavailable (simulado)");
  }
  collection(name) {
    return new CollectionRef(this, name);
  }
  seed(collectionName, id, value) {
    if (!this.data[collectionName]) this.data[collectionName] = new Map();
    this.data[collectionName].set(id, value);
  }
  all(collectionName) {
    return [...(this.data[collectionName] || new Map()).entries()].map(([id, value]) => Object.assign({ id }, value));
  }
}

const fieldValue = {
  serverTimestamp: () => "__serverTimestamp__",
  increment: (value) => ({ __increment: value })
};

module.exports = { FirestoreStub, fieldValue };
