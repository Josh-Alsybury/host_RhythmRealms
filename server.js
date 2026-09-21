const http = require('http');
const url = require('url');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const crypto = require('crypto');

// --- Environment variables ---
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const REDIRECT_URI =
  process.env.REDIRECT_URI || 'http://127.0.0.1:8888/callback';

const PORT = process.env.PORT || 8888;

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || '*';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET env vars.');
}

// ============================================================
// SESSION STORAGE
// ============================================================

// Each connected game gets its own session.
const sessions = new Map();

// Session structure:
//
// {
//   tokens: {
//     access_token,
//     refresh_token
//   },
//   tokenExpiresAt: 0,
//   spotifyConnected: false,
//   lastTrackId: null,
//   currentBPM: 120
// }


// ============================================================
// BPM CACHE
// ============================================================

const BPM_CACHE_FILE = 'bpm_cache.json';

let bpmCache = {};

try {
  bpmCache = JSON.parse(
    fs.readFileSync(BPM_CACHE_FILE, 'utf8')
  );

  console.log(
    ` Loaded ${Object.keys(bpmCache).length} cached BPMs`
  );
} catch (err) {
  console.log(' Starting with empty BPM cache');
}

function saveBPMCache() {
  fs.writeFileSync(
    BPM_CACHE_FILE,
    JSON.stringify(bpmCache, null, 2)
  );
}


// ============================================================
// CORS
// ============================================================

function setCORS(res) {
  res.setHeader(
    'Access-Control-Allow-Origin',
    ALLOWED_ORIGIN
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );
}


// ============================================================
// CREATE SESSION
// ============================================================

function createSession() {
  const sessionId = crypto.randomBytes(32).toString('hex');

  sessions.set(sessionId, {
    tokens: {},
    tokenExpiresAt: 0,
    spotifyConnected: false,
    lastTrackId: null,
    currentBPM: 120
  });

  console.log(` New session created: ${sessionId}`);

  return sessionId;
}


// ============================================================
// GET SESSION
// ============================================================

function getSession(sessionId) {
  if (!sessionId) {
    return null;
  }

  return sessions.get(sessionId) || null;
}


// ============================================================
// SPOTIFY TOKEN EXCHANGE
// ============================================================

function exchangeCodeForTokens(session, code, callback) {
  const postData = querystring.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  });

  requestToken(session, postData, callback);
}


// ============================================================
// REFRESH ACCESS TOKEN
// ============================================================

function refreshAccessToken(session, callback) {
  if (!session.tokens.refresh_token) {
    callback(
      new Error(
        'No refresh token stored. Please connect Spotify again.'
      )
    );

    return;
  }

  const postData = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: session.tokens.refresh_token
  });

  requestToken(session, postData, callback);
}


// ============================================================
// REQUEST SPOTIFY TOKEN
// ============================================================

function requestToken(session, postData, callback) {
  const authString =
    Buffer
      .from(`${CLIENT_ID}:${CLIENT_SECRET}`)
      .toString('base64');

  const options = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',

    headers: {
      'Content-Type':
        'application/x-www-form-urlencoded',

      'Content-Length':
        Buffer.byteLength(postData),

      'Authorization':
        `Basic ${authString}`
    }
  };

  const req = https.request(
    options,
    (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);

          if (parsed.error) {
            console.error('Token error:', parsed);

            callback(
              new Error(
                parsed.error_description ||
                parsed.error
              )
            );

            return;
          }

          session.tokens.access_token =
            parsed.access_token;

          // Spotify may only return the refresh token
          // during the initial authorization.
          if (parsed.refresh_token) {
            session.tokens.refresh_token =
              parsed.refresh_token;
          }

          session.tokenExpiresAt =
            Date.now() +
            (parsed.expires_in - 60) * 1000;

          console.log(' Spotify token updated');

          callback(null);

        } catch (err) {
          callback(err);
        }
      });
    }
  );

  req.on('error', callback);

  req.write(postData);
  req.end();
}


// ============================================================
// CURRENTLY PLAYING
// ============================================================

function getCurrentlyPlaying(session, callback) {
  if (
    !session.tokens.refresh_token &&
    !session.tokens.access_token
  ) {
    callback({
      error: 'Spotify not connected.',
      bpm: session.currentBPM
    });

    return;
  }

  const needsRefresh =
    !session.tokens.access_token ||
    Date.now() >= session.tokenExpiresAt;

  if (needsRefresh) {

    refreshAccessToken(session, (err) => {

      if (err) {
        callback({
          error: err.message,
          bpm: session.currentBPM
        });

        return;
      }

      fetchCurrentlyPlaying(
        session,
        callback
      );
    });

  } else {

    fetchCurrentlyPlaying(
      session,
      callback
    );
  }
}


// ============================================================
// FETCH CURRENTLY PLAYING FROM SPOTIFY
// ============================================================

function fetchCurrentlyPlaying(session, callback) {

  const options = {
    hostname: 'api.spotify.com',

    path:
      '/v1/me/player/currently-playing',

    method: 'GET',

    headers: {
      'Authorization':
        `Bearer ${session.tokens.access_token}`
    }
  };

  const req = https.request(
    options,
    (res) => {

      if (res.statusCode === 204) {
        callback({
          playing: false,
          bpm: session.currentBPM
        });

        return;
      }

      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {

        if (!data) {
          callback({
            playing: false,
            bpm: session.currentBPM
          });

          return;
        }

        try {

          const parsed = JSON.parse(data);

          const trackId =
            parsed?.item?.id;

          const trackName =
            parsed?.item?.name;

          const artistName =
            parsed?.item?.artists?.[0]?.name;


          // New track for THIS player
          if (
            trackId &&
            trackId !== session.lastTrackId
          ) {

            session.lastTrackId = trackId;

            console.log(
              ` Track changed: ${trackName} by ${artistName}`
            );


            // Global BPM cache
            if (bpmCache[trackId]) {

              session.currentBPM =
                bpmCache[trackId];

              console.log(
                ` Using cached BPM: ${session.currentBPM}`
              );

            } else {

              fetchBPMFromRapidAPI(
                session,
                trackId
              );
            }
          }


          callback({
            track: trackName,
            artist: artistName,
            bpm: session.currentBPM,
            playing: parsed?.is_playing
          });

        } catch (err) {

          callback({
            error: err.message,
            bpm: session.currentBPM
          });
        }
      });
    }
  );

  req.on('error', (e) => {

    callback({
      error: e.message,
      bpm: session.currentBPM
    });

  });

  req.end();
}


// ============================================================
// RAPIDAPI BPM
// ============================================================

function fetchBPMFromRapidAPI(
  session,
  spotifyTrackId
) {

  console.log(
    ` Fetching BPM for track: ${spotifyTrackId}`
  );

  const options = {

    hostname:
      'track-analysis.p.rapidapi.com',

    path:
      `/pktx/spotify/${spotifyTrackId}`,

    method: 'GET',

    headers: {

      'x-rapidapi-key':
        RAPIDAPI_KEY,

      'x-rapidapi-host':
        'track-analysis.p.rapidapi.com'
    }
  };


  const req = https.request(
    options,
    (res) => {

      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {

        try {

          const parsed =
            JSON.parse(data);


          if (res.statusCode === 429) {

            console.log(
              '⚠ Rate limit hit — keeping last BPM:',
              session.currentBPM
            );

            return;
          }


          if (parsed.tempo) {

            session.currentBPM =
              parsed.tempo;

            bpmCache[spotifyTrackId] =
              parsed.tempo;

            saveBPMCache();

            console.log(
              ` BPM updated: ${session.currentBPM}`
            );

          } else {

            console.log(
              '⚠ No tempo in response:',
              parsed
            );
          }

        } catch (err) {

          console.error(
            ' Error parsing RapidAPI response:',
            err
          );
        }
      });
    }
  );


  req.on('error', (e) => {

    console.error(
      ' RapidAPI request error:',
      e
    );

  });

  req.end();
}


// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(
  (req, res) => {

    const parsedUrl =
      url.parse(req.url, true);


    // --------------------------------------------------------
    // CORS PREFLIGHT
    // --------------------------------------------------------

    if (req.method === 'OPTIONS') {

      setCORS(res);

      res.writeHead(204);

      res.end();

      return;
    }


    // --------------------------------------------------------
    // CREATE SESSION
    // --------------------------------------------------------

    if (
      parsedUrl.pathname === '/session'
    ) {

      const sessionId =
        createSession();

      setCORS(res);

      res.writeHead(
        200,
        {
          'Content-Type':
            'application/json'
        }
      );

      res.end(
        JSON.stringify({
          session: sessionId
        })
      );

      return;
    }


    // --------------------------------------------------------
    // LOGIN
    // --------------------------------------------------------

    if (
      parsedUrl.pathname === '/login'
    ) {

      const sessionId =
        parsedUrl.query.session;

      const session =
        getSession(sessionId);


      if (!session) {

        res.writeHead(
          400,
          {
            'Content-Type':
              'text/plain'
          }
        );

        res.end(
          'Invalid or missing session.'
        );

        return;
      }


      const scopes =
        'user-read-playback-state user-read-currently-playing';


      const authURL =
        'https://accounts.spotify.com/authorize?' +
        querystring.stringify({

          response_type: 'code',

          client_id: CLIENT_ID,

          scope: scopes,

          redirect_uri:
            REDIRECT_URI,

          state:
            sessionId
        });


      res.writeHead(
        302,
        {
          Location: authURL
        }
      );

      res.end();

      return;
    }


    // --------------------------------------------------------
    // SPOTIFY CALLBACK
    // --------------------------------------------------------

    if (
      parsedUrl.pathname === '/callback'
    ) {

      const code =
        parsedUrl.query.code;

      const sessionId =
        parsedUrl.query.state;

      const session =
        getSession(sessionId);


      if (!code || !session) {

        res.writeHead(
          400,
          {
            'Content-Type':
              'text/plain'
          }
        );

        res.end(
          'Invalid Spotify callback.'
        );

        return;
      }


      exchangeCodeForTokens(
        session,
        code,
        (err) => {

          setCORS(res);


          if (err) {

            res.writeHead(
              500,
              {
                'Content-Type':
                  'text/plain'
              }
            );

            res.end(
              'Token exchange failed: ' +
              err.message
            );

            return;
          }


          session.spotifyConnected =
            true;


          res.writeHead(
            200,
            {
              'Content-Type':
                'text/html'
            }
          );


          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Rhythm Realms</title>
            </head>

            <body>

              <h1>Spotify Connected ✓</h1>

              <p>
                You can return to Rhythm Realms.
              </p>

            </body>
            </html>
          `);
        }
      );

      return;
    }


    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    if (
      parsedUrl.pathname === '/status'
    ) {

      const sessionId =
        parsedUrl.query.session;

      const session =
        getSession(sessionId);


      setCORS(res);

      res.writeHead(
        200,
        {
          'Content-Type':
            'application/json'
        }
      );


      if (!session) {

        res.end(
          JSON.stringify({
            connected: false,
            error: 'Invalid session'
          })
        );

        return;
      }


      res.end(
        JSON.stringify({
          connected:
            session.spotifyConnected
        })
      );

      return;
    }


    // --------------------------------------------------------
    // CURRENT
    // --------------------------------------------------------

    if (
      parsedUrl.pathname === '/current'
    ) {

      const sessionId =
        parsedUrl.query.session;

      const session =
        getSession(sessionId);


      setCORS(res);

      res.writeHead(
        200,
        {
          'Content-Type':
            'application/json'
        }
      );


      if (!session) {

        res.end(
          JSON.stringify({
            error: 'Invalid session'
          })
        );

        return;
      }


      getCurrentlyPlaying(
        session,
        (data) => {

          res.end(
            JSON.stringify(
              data,
              null,
              2
            )
          );

        }
      );

      return;
    }


    // --------------------------------------------------------
    // NOT FOUND
    // --------------------------------------------------------

    setCORS(res);

    res.writeHead(
      404,
      {
        'Content-Type':
          'text/plain'
      }
    );

    res.end('Not Found');
  }
);


// ============================================================
// START SERVER
// ============================================================

server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      ` Server running on port ${PORT}`
    );

    console.log(
      ` Spotify redirect URI: ${REDIRECT_URI}`
    );

  }
);