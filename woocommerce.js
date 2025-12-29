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
    consumer_key: 'ck_7647b84ee4dba7403ce4bd080710248497d2a89f',
    consumer_secret: 'cs_8d77cb29de49d40dcdf94007867576ae5f65dd0b'
  };
}

module.exports = { apiAxios, addWooAuth };