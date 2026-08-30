"use strict";

/** Request/Response minimos compatibles con Express para probar el handler. */

function makeRequest({ method = "POST", path = "/", headers = {}, body = undefined } = {}) {
  const lower = {};
  Object.entries(headers).forEach(([key, value]) => {
    lower[key.toLowerCase()] = value;
  });
  return {
    method,
    path,
    url: path,
    headers: lower,
    body,
    rawBody: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
    get(name) {
      return lower[String(name).toLowerCase()] || "";
    }
  };
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    set(key, value) {
      this.headers[String(key).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    }
  };
}

module.exports = { makeRequest, makeResponse };
