const http = require('http');
const url = require('url');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');

// --- Secrets come from environment variables now. Set these on your host,
// never in the source file. ---
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// Set this to your deployed URL once you have one, e.g.
// https://your-app.onrender.com/callback
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://127.0.0.1:8888/callback';

const PORT = process.env.PORT || 8888;

// If you only want your itch.io page to be allowed to call this API,
// set ALLOWED_ORIGIN to it, e.g. https://yourname.itch.io
// '*' works too but means literally any website can query your server.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET env vars.');
}

let tokens = {};
let tokenExpiresAt = 0; // epoch ms
let lastTrackId = null;
let currentBPM = 120;

const TOKEN_FILE = 'tokens.json';
const BPM_CACHE_FILE = 'bpm_cache.json';

// --- Load persisted refresh token (so a server restart doesn't force a re-login) ---
try {
  tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  console.log(' Loaded saved refresh token');
} catch (err) {
  console.log('No saved token yet — visit /login once to authorize');
}

function saveTokens() {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

// --- BPM cache ---
let bpmCache = {};
try {
  bpmCache = JSON.parse(fs.readFileSync(BPM_CACHE_FILE, 'utf8'));
  console.log(` Loaded ${Object.keys(bpmCache).length} cached BPMs`);
} catch (err) {
  console.log(' Starting with empty BPM cache');
}
function saveBPMCache() {
  fs.writeFileSync(BPM_CACHE_FILE, JSON.stringify(bpmCache, null, 2));
}

// --- CORS helper: call at the top of every response ---
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// --- Exchange authorization code for tokens ---
function exchangeCodeForTokens(code, callback) {
  const postData = querystring.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  requestToken(postData, callback);
}

// --- Use refresh token to get a new access token ---
function refreshAccessToken(callback) {
  if (!tokens.refresh_token) {
    callback(new Error('No refresh token stored. Visit /login first.'));
    return;
  }
  const postData = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  requestToken(postData, callback);
}

function requestToken(postData, callback) {
  const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const options = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
      'Authorization': `Basic ${authString}`,
    },
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.error) {
          console.error('Token error:', parsed);
          callback(new Error(parsed.error_description || parsed.error));
          return;
        }
        tokens.access_token = parsed.access_token;
        // refresh_token is only returned on the *first* exchange — keep the old one otherwise
        if (parsed.refresh_token) tokens.refresh_token = parsed.refresh_token;
        tokenExpiresAt = Date.now() + (parsed.expires_in - 60) * 1000; // refresh 1 min early
        saveTokens();
        console.log(' Tokens updated');
        callback(null);
      } catch (err) {
        callback(err);
      }
    });
  });

  req.on('error', callback);
  req.write(postData);
  req.end();
}

// --- Fetch currently playing track, refreshing the access token first if needed ---
function getCurrentlyPlaying(callback) {
  if (!tokens.refresh_token && !tokens.access_token) {
    callback({ error: 'Not authorized yet. Visit /login once.', bpm: currentBPM });
    return;
  }

  const needsRefresh = !tokens.access_token || Date.now() >= tokenExpiresAt;
  if (needsRefresh) {
    refreshAccessToken((err) => {
      if (err) {
        callback({ error: err.message, bpm: currentBPM });
        return;
      }
      fetchCurrentlyPlaying(callback);
    });
  } else {
    fetchCurrentlyPlaying(callback);
  }
}

function fetchCurrentlyPlaying(callback) {
  const options = {
    hostname: 'api.spotify.com',
    path: '/v1/me/player/currently-playing',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode === 204) {
      callback({ playing: false, bpm: currentBPM });
      return;
    }

    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      if (!data) {
        callback({ playing: false, bpm: currentBPM });
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const trackId = parsed?.item?.id;
        const trackName = parsed?.item?.name;
        const artistName = parsed?.item?.artists?.[0]?.name;

        if (trackId && trackId !== lastTrackId) {
          lastTrackId = trackId;
          console.log(` Track changed: ${trackName} by ${artistName}`);

          if (bpmCache[trackId]) {
            currentBPM = bpmCache[trackId];
            console.log(` Using cached BPM: ${currentBPM}`);
          } else {
            fetchBPMFromRapidAPI(trackId);
          }
        }

        callback({
          track: trackName,
          artist: artistName,
          bpm: currentBPM,
          playing: parsed?.is_playing,
        });
      } catch (err) {
        callback({ error: err.message, bpm: currentBPM });
      }
    });
  });

  req.on('error', (e) => callback({ error: e.message, bpm: currentBPM }));
  req.end();
}

function fetchBPMFromRapidAPI(spotifyTrackId) {
  console.log(` Fetching BPM for track: ${spotifyTrackId}`);
  const options = {
    hostname: 'track-analysis.p.rapidapi.com',
    path: `/pktx/spotify/${spotifyTrackId}`,
    method: 'GET',
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': 'track-analysis.p.rapidapi.com',
    },
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (res.statusCode === 429) {
          console.log('⚠ Rate limit hit — keeping last BPM:', currentBPM);
          return;
        }
        if (parsed.tempo) {
          currentBPM = parsed.tempo;
          bpmCache[spotifyTrackId] = currentBPM;
          saveBPMCache();
          console.log(` BPM updated: ${currentBPM}`);
        } else {
          console.log('⚠ No tempo in response:', parsed);
        }
      } catch (err) {
        console.error(' Error parsing RapidAPI response:', err);
      }
    });
  });

  req.on('error', (e) => console.error(' RapidAPI request error:', e));
  req.end();
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (parsedUrl.pathname === '/login') {
    const scopes = 'user-read-playback-state user-read-currently-playing';
    const authURL = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: scopes,
      redirect_uri: REDIRECT_URI,
    });
    res.writeHead(302, { Location: authURL });
    res.end();

  } else if (parsedUrl.pathname === '/callback') {
    const code = parsedUrl.query.code;
    if (code) {
      exchangeCodeForTokens(code, (err) => {
        setCORS(res);
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(' Token exchange failed: ' + err.message);
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(' Authorization successful! You can close this tab.');
        }
      });
    } else {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(' No authorization code');
    }

  } else if (parsedUrl.pathname === '/current') {
    getCurrentlyPlaying((data) => {
      setCORS(res);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    });

  } else {
    setCORS(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Server running on port ${PORT}`);
  console.log(`   Visit /login once to authorize with Spotify.`);
});