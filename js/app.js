import { credentials } from "./credentials.js";
import { CustomLocalStorage } from "../../spotify-util/js/customLocalStorage.js";

const CURRENT_VERSION = "0.0.9";
const USER_OPTIONS = {
    allow_duplicates:false,
    setOption: function (option_name, option_value) {
        //if(!option_name || !option_value) return false;
        if (this[option_name] !== undefined) return this[option_name] = option_value;
    },
    resetOptions: function () {
        this.allow_duplicates = false;
    }
};

//some global variables
var customLocalStorage  = new CustomLocalStorage('playlistscrobbler');
var spotify_credentials = null;
var lastfm_credentials  = null;
var CURRENTLY_RUNNING   = false;
var tracks_scrobbled    = [];
var tracks_ignored      = [];
var database;

const callSpotify = function (url, data) {
    if(!spotify_credentials) return new Promise((resolve, reject) => reject("no spotify_credentials"));
    return $.ajax(url, {
        dataType: 'json',
        data: data,
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token
        }
    });
};

const postLastfm = function (data) {
    data = {
        ...data,
        api_key: credentials.lastfm.key,
        sk: lastfm_credentials.session_key,
        method: 'track.scrobble'
    };
    data.api_sig = md5(Object.entries(data).sort(/*default method sorts subarrays too apparently, that's cool*/).map((subarr) => subarr.join('')).join('') + credentials.lastfm.secret);
    data.format = 'json';   //this cannot be included in the api_sig
    return $.ajax(`http://ws.audioscrobbler.com/2.0/`, {
        type: 'POST',
        dataType: 'json',
        data: data
    });
};

const okToRecursivelyFix = function (error_obj) {
    //determine if an error object is an api rate issue that can be fixed by calling it again,
    //or an error on our end (such as syntax) that can't be fixed by recalling the api
    console.log("checking if err is ok to recursively fix", error_obj);
    if (error_obj.status >= 429) {
        console.log("err IS ok to recursively fix", error_obj);
        return true;
    } else {
        console.log("err NOT ok to recursively fix", error_obj);
        return false
    };
};

const loginWithSpotify = function () {
    let url = 'https://accounts.spotify.com/authorize?client_id=' + credentials.spotify.client_id +
        '&response_type=token' +
        '&scope=' + encodeURIComponent(credentials.spotify.scopes) +
        '&redirect_uri=' + encodeURIComponent(credentials.spotify.redirect_uri);

    //redirect the page to spotify's login page. after login user comes back to our page with a token in
    //page hash, or, if they're already logged in, a token in customLocalStorage's spotify_credentials
    document.location = url;
};

const loginWithLastfm = function () {
    document.location = `http://www.last.fm/api/auth?api_key=${credentials.lastfm.key}&cb=http://glassintel.com/elijah/programs/playlistscrobbler`;
};

const getTime = function () {
    return Math.round(new Date().getTime() / 1000);
};

const ERROR_OBJ = {
    //100: invalid input
    
};

const displayError = function (code) {
    console.log(`Displaying error ${code}`);
};

window.progress_bar = new ProgressBar.Line('#progress-bar', {
    color: '#1DB954',   //not necessary since we have step, but i'm including it for reference
    duration: 300,
    easing: 'easeOut',
    strokeWidth: 2,
    step: (state, bar, attachment) => bar.path.setAttribute('stroke', state.color) //this is purely so we can change to red on error, otherwise step would be unencessary
});

/**
 * Scales number n in the given domain to the target domain
 * 
 * @param {number} n            - The number to scale
 * @param {number} given_min    - The lower limit of n's domain
 * @param {number} given_max    - The upper limit of n's domain
 * @param {number} target_min   - The lower limit of the domain for n to be scaled into
 * @param {number} target_max   - The upper limit of the domain for n to be scaled into
 * @return {number} The corresponding value for n in the target domain 
 */
const scaleNumber = function (n, given_min, given_max, target_min, target_max) {
    const given_range = given_max - given_min;
    const target_range = target_max - target_min;
    return ((n - given_min) * target_range / given_range) + target_min;
};

const progressBarHandler = function ({current_operation, total_operations, stage = 1, ...junk} = {}) {
    //the idea is that each api call we make results in the progress bar updating
    //we need to get the total number of calls that will be made
    //let total_operations = total_tracks + Math.ceil(total_tracks / 20) + Math.ceil(total_tracks / 100);
                            //+ recursive_operations.missing_tracks + recursive_operations.get_album_calls;
    //^ see the algorithm used in estimateTimeTotal
    if(stage == 'error') {
        progress_bar.animate(progress_bar.value(), {from:{color:'#e31c0e'}, to:{color:'#e31c0e'}});    //red
        $("#estimated-time-remaining p").text('Error');
        return;
    }
    if(stage == "done") {
        progress_bar.animate(1, {from:{color:'#1DB954'}, to:{color:'#1DB954'}});
        $("#estimated-time-remaining p").text("Done!");
        return;
    }

    let animate_value = 0;

    let stage_text = {
        1:() => "Getting your playlists...",
        2:() => {
            if(!junk.playlist_name) return `Retrieving playlist songs...`;
            else return `Retrieving songs from playlist ${junk.playlist_name}...`;
        },
        3:() => "Filtering songs...",
        4:() => "Creating playlist...",
        5:() => "Adding songs to playlist..."
    },
    total_stages = Object.keys(stage_text).length;

    console.log(`stage: ${stage}, value: ${current_operation}/${total_operations}`);

    animate_value = scaleNumber(current_operation, 0, total_operations, ((stage - 1) / total_stages), (stage / total_stages));
    console.log(animate_value);

    if(animate_value < progress_bar.value()) animate_value = progress_bar.value();  //prevent the progressbar from ever going backwards
    if(animate_value > 1) animate_value = 1;    //prevent the progressbar from performing weird visuals
    progress_bar.animate(animate_value, {from:{color:'#1DB954'}, to:{color:'#1DB954'}});

    $("#estimated-time-remaining p").text(stage_text[stage]());
};

const checkSpotifyToken = async function () {
    // if we already have a token and it hasn't expired, use it
    spotify_credentials = customLocalStorage.getItem('spotify_credentials');

    if (spotify_credentials?.expires > getTime()) {
        console.log("found unexpired spotify token!");
        if(!!location.hash) location.hash = ''; //clear the hash just in case 
        return true;
    } else {
        // we have a spotify token as a hash parameter in the url
        // so parse hash

        var hash = location.hash.replace(/#/g, '');
        var all = hash.split('&');
        var args = {};

        all.forEach(function (keyvalue) {
            var idx = keyvalue.indexOf('=');
            var key = keyvalue.substring(0, idx);
            var val = keyvalue.substring(idx + 1);
            args[key] = val;
        });

        if (typeof (args['access_token']) != 'undefined') {
            console.log("found spotify token in url");
            var g_access_token = args['access_token'];
            var expiresAt = getTime() + 3600 - 300 /*5 min grace so that token doesnt expire while program is running*/;

            if (typeof (args['expires_in']) != 'undefined') {
                var expires = parseInt(args['expires_in']);
                expiresAt = expires + getTime();
            }

            spotify_credentials = {
                token: g_access_token,
                expires: expiresAt
            };

            try {
                const user = await callSpotify('https://api.spotify.com/v1/me');
                spotify_credentials.uid = user.id;
                customLocalStorage.setItem("spotify_credentials", spotify_credentials);
                return true;    //logeed in succesfully
            } catch (err) {
                console.error(err);
                return false;
            } finally {
                location.hash = '';
            }
        } else
        return false;
    }
};

const checkLastfmToken = async function () {
    //unlike spotify, lastfm tokens are passed as a query instead of a hash
    try {
        lastfm_credentials = customLocalStorage.getItem('lastfm_credentials');
            
        if(lastfm_credentials?.session_key) {
            console.log("found unexpired lastfm session key!");
            if(!!location.search) location.search = ''; //clear the query in case user shares link w token
            return true;
        }

        const search_params = new URLSearchParams(window.location.search);  //not supported on any version of IE, but screw IE users. I'd rather user chrome than IE and that's saying a lot
        if(!search_params.has('token')) throw new Error('No lastfm token found in URL');
        //now we need to get a web service session (https://www.last.fm/api/webauth)
        const res = await $.ajax(`http://ws.audioscrobbler.com/2.0`, {
            dataType: 'json',
            data: {
                format: 'json',
                method: 'auth.getSession',
                api_key: credentials.lastfm.key,
                token: search_params.get('token'),
                api_sig: md5(`api_key${credentials.lastfm.key}methodauth.getSessiontoken${search_params.get('token')}${credentials.lastfm.secret}`)
            }
        });
        console.log(res);

        lastfm_credentials = {
            name: res.session.name,
            session_key: res.session.key
        };

        customLocalStorage.setItem("lastfm_credentials", lastfm_credentials);
        location.search = ''; //clear the query in case user shares link w token
        return true;    //successful login
    } catch (err) {
        console.error(err);
        return false;   //unsuccesful login
    }
};

const performAuthDance = async function () {
    const [spotify_auth, lastfm_auth] = [await checkSpotifyToken(), await checkLastfmToken()];
    
    if(spotify_auth && !lastfm_auth) {
        $('#spotify-login-page').addClass('hidden');
        $('#lastfm-login-page').removeClass('hidden');
        return;
    }
    if(spotify_auth && lastfm_auth) {
        $('#spotify-login-page').addClass('hidden');
        $('#lastfm-login-page').addClass('hidden');
        $('#main-page').removeClass('hidden');
        return;
    }
    return; //to resolve the promise?
};

const resolvePromiseArray = function (promise_array, callback) {
    Promise.all(promise_array).then((results) => callback(false, results)).catch((err) => {
        console.log(`error found in resolvePromiseArray: `, err);
        callback(true, err);
        //removing ^ that should stop the TypeError: finished_api_calls.forEach is not a function
    });
};

/**
 * checks playlist input to ensure it contains a playlist id 
 * @param {string} input String to check
 * @returns {Boolean} True if string contains a playlist id, false if not
 */
const checkInput = function (input) {
    input = input.toString().trim();   //remove whitespace
    if((input.startsWith('http') && input.includes('open.spotify.com') && input.includes('/playlist/')) ||
       (input.startsWith('open.spotify.com') && input.includes('/playlist/')) ||
        input.startsWith('spotify:playlist:')) return true;
    return false;
};

/**
 * Extracts the playlist id from a string
 * @param {string} input String that has passed the `checkInput()` function
 * @returns {string} A Spotify playlist ID
 */
const getId = function getIdFromPlaylistInput(input) {
    //function assumes input passed the checkInput function
    input = input.toString().trim();
    let id = undefined; //default to undefined for error handling
    //if we have a url
    if(input.startsWith('http') || input.includes('open.spotify.com')) id = input.split('/').pop().split('?')[0];
    //if we have a uri
    else if(input.startsWith('spotify:playlist:')) id = input.split(':').pop(); //even though .pop() is somewhat inefficent, its less practical to get the length of the array and use that as our index
    return id;
};

/**
 * Retrieves all tracks from a playlist and adds them to a global array. Ignores local files
 * 
 * @param {string} playlist_id - The ID of the playlist to retrieve tracks from
 * @return {Promise<Array>} - A promise that resolves with an array of tracks (only uris and explicitness) from the requested playlist
 */
const getPlaylistTracksHandler = function (playlist_id) {
    let options = {
        fields:"next,items(added_at,track(uri,id,is_local,name,artists,album,type,duration_ms,track_number))",
        market:"from_token",
        limit:100
    }, playlist_songs = [];
    
    const recursivelyRetrieveAllPlaylistTracks = function (url, options = {}) {
        return new Promise((resolve, reject) => {
            callSpotify(url, options).then(async res => {
                //go thru all tracks in this api res and push them to array
                for(const item of res.items) {
                    let track = item["track"];
                    //found a rare, undocumented case of the track object sometimes returning null, specifically when calling the endpoint for this playlist: 6BbewZJ0Cv6V9XSXyyDBSm
                    //there's also podcasts, so the track has to be of a specific type
                    if(!!track && !track.is_local && track.type == 'track') playlist_songs.push(item);
                }
                //if there's more songs in the playlist, call ourselves again, otherwise resolve
                if(!res.next) {
                    resolve({playlist_songs:playlist_songs, playlist_id:playlist_id});  //resolve an object that will be handeled in our .then() catcher
                } else await recursivelyRetrieveAllPlaylistTracks(res.next).then(res=>resolve(res)).catch(err=>reject(err));    //evidently this then/catch is necessary to get the promise to return something
            }).catch(err => {
                console.log("error in getAllPlaylistTracks... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyRetrieveAllPlaylistTracks(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    return recursivelyRetrieveAllPlaylistTracks(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks`, options);
};

/**
 * 
 * @param {string} playlist_id 
 * @returns {Promise<Array>}
 */
const getPlaylistTracks = async function (playlist_id = '') {
    try {
        return await getPlaylistTracksHandler(playlist_id).then((res_obj) => res_obj.playlist_songs);
    } catch (err) {
        console.log(`Error in getPlaylistTracks try-catch block:`, err);
        throw err;
    }
};

/**
 * Filters an array of tracks against a set of global options
 * 
 * @param {Array} track_array - The array of tracks to filter
 * @return {Array<Array, Array>} - Two arrays. First one contains the tracks that passed filtration and the second contains tracks that failed.
 */
const filterTracks = function (track_array = []) {
    let [filtered_array, rejected_array] = [[...track_array], []];
    console.log(filtered_array, rejected_array);

    //remove duplicate timestamps
    filtered_array = filtered_array.reduce((acc, cur) => {
        //if current track shares a timestamp with a track already in the reduced array, reject it
        !!acc.find(track => track.added_at === cur.added_at) ? 
            rejected_array.push({...cur, warning:{title:'Duplicate timestamp', message:'This song has a duplicate timestamp as another song in the playlist. For obvious reasons, it is not possible to listen to two songs at once.'}}) :
            acc.push(cur);
        return acc;
    }, []);
    console.log(filtered_array, rejected_array);
    //remove tracks older than two weeks
    filtered_array = filtered_array.reduce((acc, cur) => {
        const now = new Date();
        new Date(cur.added_at) < new Date(now.setDate(now.getDate()-14)) ?
            rejected_array.push({...cur, warning:{title:'Track too old', message:'Per Lastfm regulations, tracks older than two weeks cannot be scrobbled to an account.'}}) :
            acc.push(cur);
        return acc;
    }, []);
    console.log(filtered_array, rejected_array);
    //remove duplicate tracks
    if(!USER_OPTIONS.allow_duplicates) filtered_array = filtered_array.reduce((acc, cur) => {
        console.log([...acc].pop()?.uri == cur.uri);
        [...acc].pop()?.track?.uri == cur.track.uri ?
            rejected_array.push({...cur, warning:{title:'Duplicate track', message:'This track appeared as a back-to-back duplicate and was caught by the Allow Duplicates option'}}) :
            acc.push(cur);
        return acc;
    }, []);
    console.log(filtered_array, rejected_array);
    return [filtered_array, rejected_array];
};

//parse the tracks to be sent to Lastfm's API
const parseTracks = function (track_array) {
    let return_data = {};
    for (let i = 0; i < track_array.length; i++) {
        const track = track_array[i].track;
        return_data = {
            ...return_data,
            [`track[${i}]`]: track.name,
            [`artist[${i}]`]: track.artists[0].name,
            [`timestamp[${i}]`]: new Date(track_array[i].added_at).getTime() / 1000,
            [`album[${i}]`]: track.album.name,
            [`duration[${i}]`]: Math.round(track.duration_ms / 1000),
            [`trackNumber[${i}]`]: track.track_number,
            [`chosenByUser[${i}]`]: 0
        };
    }
    return return_data;
};

//update global variables depending on response of api call
const checkScrobbleRes = function (res) {
    //can't iterate over a single response (api restrictions)
    if(res.scrobbles['@attr']?.accepted === 1 || res.scrobbles['@attr']?.ignored === 1) {
        const scrobble = res.scrobbles.scrobble;
        if(scrobble.ignoredMessage.code == 1) 
            tracks_ignored.push({...scrobble, warning:{title:'Rejected by Last.fm', message:scrobble.ignoredMessage['#text']}});
        else tracks_scrobbled.push(scrobble);
        return;
    }

    for (const scrobble of res.scrobbles.scrobble) {
        if(scrobble.ignoredMessage.code == 1) 
            tracks_ignored.push({...scrobble, warning:{title:'Rejected by Last.fm', message:scrobble.ignoredMessage['#text']}});
        else tracks_scrobbled.push(scrobble);
    }
};

const renderScrobbles = function(tracks_scrobbled, tracks_ignored) {
    for(const item of tracks_ignored) {
        const track = item.track;
        $('#track-confirmation').append(`
            <div class="track-wrapper">
                <span class="status error" onclick="alert('${item?.warning.message || 'Could not load info'}');" title="Click to view more info">${item?.warning.title || "Not Scrobbled"}</span>
                <div class="track">
                    <img src="${track.album?.images[0]?.url || './img/default_playlist_img.jpg'}" alt="Album art for '${track.album.name}'">
                    <p>
                        <span id="title">${track.name}</span><br>
                        by <span id="artist">${track.artists[0].name}</span>
                    </p>
                </div>
            </div>
        `);
    }
    for(const item of tracks_scrobbled) {
        console.log(item);
        const track = item.track;
        $('#track-confirmation').append(`
            <div class="track-wrapper">
                <span class="status success">Scrobbled Succesfully</span>
                <div class="track">
                    <img src="${track.album?.images[0]?.url || './img/default_playlist_img.jpg'}" alt="Album art for '${track.album.name}'">
                    <p>
                        <span id="title">${track.name}</span><br>
                        by <span id="artist">${track.artists[0].name}</span>
                    </p>
                </div>
            </div>
        `);
    }
};

const main = async function () {
    //reset global stuff
    CURRENTLY_RUNNING = true;
    try {
        //progressBarHandler({remaining_tracks:tracks_to_receive, total_tracks:track_count}); //get a progressbar visual up for the user
        let new_session = database.ref('playlistscrobbler/sessions').push();
        new_session.set({
            sessionTimestamp: new Date().getTime(),
            sessionID: new_session.key,
            //sessionStatus:"pending",
            spotifyUID: spotify_credentials.uid,
            lastfmUser: lastfm_credentials.name,
            userAgent: navigator.userAgent
        }, function (error) {
            if(error) console.log("Firebase error", error);
            else console.log("Firebase data written successfully");
        });
        
        const raw_playlist_tracks = await getPlaylistTracks(getId(document.getElementById('playlist-url').value));
        console.log(raw_playlist_tracks);
        
        //progressBarHandler({current_operation:1, total_operations:2, stage:3});
        const [playlist_tracks, rejected_tracks] = filterTracks(raw_playlist_tracks);
        tracks_ignored.push(...rejected_tracks);
        //progressBarHandler({current_operation:2, total_operations:2, stage:3});

        //parse tracks and scrobble them in batches of 50 or less (per lastfm API)
        let track_batch = [];
        for (let i = 0; i < playlist_tracks.length; i++) {
            if(i == 0 || i % 50 != 0) {
                track_batch.push(playlist_tracks[i]);
                continue;
            }
            console.log(i, track_batch);
            //we have 50 tracks in the array
            const parsed_tracks = parseTracks(track_batch);
            console.log(parsed_tracks);
            const res = await postLastfm(parsed_tracks);
            console.log(res);
            checkScrobbleRes(res);
            track_batch = [playlist_tracks[i]]; //reset array for next batch
        }
        renderScrobbles(tracks_scrobbled, tracks_ignored);
    } catch (e) {
        console.log("try-catch err", e);
        //progressBarHandler({stage: 'error'});  //change progressbar to red
        alert("The program enountered an error");
        //"delete" the playlist we just created
        return;
    } finally {
        CURRENTLY_RUNNING = false;
        console.log("execution finished!");
    }
    //progressBarHandler({stage: "done"});    //this is outside of the finally block to ensure it doesn't get executed if we trigger a return statement
};

$(document).ready(async function () {
    console.log(`Running Spotify Playlist Scrobbler version ${CURRENT_VERSION}\nDeveloped by Elijah O`);
    firebase.initializeApp(credentials.firebase.config);
    database = firebase.database();
    await performAuthDance();
});

$("#spotify-login-button").click(loginWithSpotify);
$("#lastfm-login-button").click(loginWithLastfm);

$("#combine-button").click(function () {
    if(CURRENTLY_RUNNING) return alert("Program is already running!");

    //$("#progress-bar-wrapper").removeClass("hidden"); //show progress bar
    //progress_bar.set(0);    //reset progressbar
    main();
});

//populates the playlist-info-wrapper with the given user information
const populateSearchInfo = function (playlist_obj = {}, jQuery_element) {
    if(playlist_obj.images.length > 0) $(jQuery_element).siblings('.playlist-info-wrapper').children('img').attr('src', playlist_obj.images[0].url);
    else $(jQuery_element).siblings('.playlist-info-wrapper').children('img').attr('src', './img/default-playlist_img.jpg');
    $(jQuery_element).siblings('.playlist-info-wrapper').children('p').text(`${playlist_obj.name} - ${playlist_obj.tracks.total} songs`);
};

$("#playlist-url").on("input", function () {
    //update the playlist info whenever the field is changed
    //if($(this).val() == current_input) return;  //prevent unnecessary api calls
    if($(this).val().trim() == '') return;    //prevent unnecessary api calls
    const current_input = $(this).val().trim();

    if(!checkInput(current_input)) {
        $(this).siblings('.playlist-info-wrapper').children('img').attr('src', './img/x-img.png');
        $(this).siblings('.playlist-info-wrapper').children('p').text('That is not a valid Spotify playlist link');
    } else {
        callSpotify(`https://api.spotify.com/v1/playlists/${getId(current_input)}`).then((playlist) => {
            if(getId(playlist.external_urls.spotify) != getId($(this).val())) return;
            if(playlist.tracks.total == 0) {
                $(this).siblings('.playlist-info-wrapper').children('img').attr('src', './img/x-img.png');
                $(this).siblings('.playlist-info-wrapper').children('p').text('That playlist does not have any tracks in it');
                return;
            }
            populateSearchInfo(playlist, this);
        }).catch(() => {
            $(this).siblings('.playlist-info-wrapper').children('img').attr('src', './img/x-img.png');
            $(this).siblings('.playlist-info-wrapper').children('p').text('That is not a valid Spotify playlist link');
        });
    }
});