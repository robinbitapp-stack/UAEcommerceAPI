const axios = require('axios');

const apiAxios = axios.create({
  baseURL: 'https://updateavenues.com/wp-json/wc/v3/',
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://updateavenues.com/',
    'Origin': 'https://updateavenues.com'
  },
  httpsAgent: new (require('https').Agent)({  
    rejectUnauthorized: false
  })
});

// Helper function to add authentication to any request
function addWooAuth(params = {}) {
  return {
    ...params,
    consumer_key: 'ck_bb500a1fb70b1094d43fd85296ad10c5dada160b',
    consumer_secret: 'cs_b7232701e74d5e22fe79c70b312e36acb4d8757a'
  };
}

module.exports = { apiAxios, addWooAuth };