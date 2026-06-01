'use strict';

const axios = require('axios');

class SalesforceClient {
  constructor({ accessToken, instanceUrl }) {
    this.accessToken = accessToken;
    this.instanceUrl = instanceUrl.replace(/\/$/, '');
  }

  async fetch(path, options = {}) {
    const response = await axios({
      url: `${this.instanceUrl}${path}`,
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      data: options.body,
      validateStatus: () => true,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => (typeof response.data === 'string' ? response.data : JSON.stringify(response.data)),
      json: async () => response.data,
    };
  }

  async query(soql) {
    const { data } = await axios.get(`${this.instanceUrl}/services/data/v62.0/query`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      params: { q: soql },
    });
    return data;
  }

  async toolingQuery(soql) {
    const { data } = await axios.get(`${this.instanceUrl}/services/data/v62.0/tooling/query`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      params: { q: soql },
    });
    return data;
  }
}

module.exports = SalesforceClient;
