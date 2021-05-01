import { credentials } from "./credentials.js";
import { CustomLocalStorage } from "../../spotify-util/js/customLocalStorage.js";

const CURRENT_VERSION = "0.0.1";
const REFRESH_RATE = { //used to control API rate limiting
    getUserPlaylists: 1,
    getPlaylistTracks: 250,
    addTracksToPlaylist: 150
};
const USER_OPTIONS = {
    allow_explicits:true,
    allow_duplicates:false,
    include_private:false,
    include_collaborative:false,
    include_followed:false,
    include_christmas:false,
    setOption: function (option_name, option_value) {
        //if(!option_name || !option_value) return false;
        if (this[option_name] !== undefined) return this[option_name] = option_value;
    },
    resetOptions: function () {
        this.allow_explicits = true;
        this.allow_duplicates = false;
        this.include_private = false;
        this.include_collaborative = false;
        this.include_followed = false;
        this.include_christmas = false;
    }
};

//some global variables
var customLocalStorage  = new CustomLocalStorage('playlistscrobbler');
window.customLocalStorage = customLocalStorage;
var spotify_credentials = null;
var lastfm_credentials  = null;
var CURRENTLY_RUNNING   = false;
var playlist_title      = "Huge Combination Playlist";
var playlist_objects    = [];
var database;
var global_playlist_tracks = [];

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

const callLastfm = function (url, data) {
    
};

const postSpotify = function (url, json, callback) {
    $.ajax(url, {
        type: "POST",
        data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token,
            'Content-Type': 'application/json'
        },
        success: function (r) {
            callback(true, r);
        },
        error: function (r) {
            // 2XX status codes are good, but some have no
            // response data which triggers the error handler
            // convert it to goodness.
            if (r.status >= 200 && r.status < 300) {
                callback(true, r);
            } else {
                callback(false, r);
            }
        }
    });
};

const deleteSpotify = function (url, callback) {
    $.ajax(url, {
        type: "DELETE",
        //data: JSON.stringify(json),
        dataType: 'json',
        headers: {
            'Authorization': 'Bearer ' + spotify_credentials.token,
            'Content-Type': 'application/json'
        },
        success: function (r) {
            callback(true, r);
        },
        error: function (r) {
            // 2XX status codes are good, but some have no
            // response data which triggers the error handler
            // convert it to goodness.
            if (r.status >= 200 && r.status < 300) {
                callback(true, r);
            } else {
                callback(false, r);
            }
        }
    });
};

/**
 * Shuffles an array and does not modify the original.
 * 
 * @param {array} array - An array to shuffle.
 * @return {array} A shuffled array.
 */
const shuffleArray = function (array) {
    //modified from https://javascript.info/task/shuffle

    let tmpArray = [...array];

    for (let i = tmpArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1)); // random RESPONSE_INDEX from 0 to i

        // swap elements tmpArray[i] and tmpArray[j]
        // we use "destructuring assignment" syntax to achieve that
        // you'll find more details about that syntax in later chapters
        // same can be written as:
        // let t = tmpArray[i]; tmpArray[i] = tmpArray[j]; tmpArray[j] = t
        [tmpArray[i], tmpArray[j]] = [tmpArray[j], tmpArray[i]];
    }
    return tmpArray;
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
        location.hash = ''; //clear the hash just in case (this can be removed later)
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
            console.log("found unexpired lastfm token!");
            location.search = ''; //clear the query in case user shares link w token
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
 * Checks a playlist against the global user options
 * 
 * @param {object} playlist_obj - A simplified playlist object to check
 * @return {boolean} Whether the playlist passes the check or not
 */
const checkPlaylist = function (playlist_obj = {}) {
    if(playlist_obj.collaborative == undefined || playlist_obj.owner == undefined || playlist_obj.public == undefined) return false;
    if(playlist_obj.tracks.total < 1) return false; //no need to get the tracks of a playlist if there aren't any there

    const isChristmas = (playlist) => {
        let name = playlist.name.toLowerCase(),
            description = playlist.description.toLowerCase();
        if(name.includes("christmas") || name.includes("xmas") || description.includes("christmas") || description.includes("xmas")) return true;
        return false;
    };
    if(!USER_OPTIONS.include_christmas && isChristmas(playlist_obj)) return false;
    //if playlist is public, return true (universal implication)
    if(playlist_obj.public) return true;
    //if user says no privates and this is their playlist and playlist is not public (private)
    if(!USER_OPTIONS.include_private && playlist_obj.owner.id == spotify_credentials.uid && !playlist_obj.public) return false;
    //if user says no collab and this is their playlist and playlist is collaborative
    if(!USER_OPTIONS.include_collaborative && playlist_obj.owner.id == spotify_credentials.uid && playlist_obj.collaborative) return false;
    //if user says no followed, and they are not the owner of the playlist
    if(!USER_OPTIONS.include_followed && playlist_obj.owner.id != spotify_credentials.uid) return false;
    return true;    //passed all tests
};

const getUserPlaylists = function () {
    //retrieves the playlists of the currently logged in user and checks them against
    //global options. stores the hrefs of playlist track list in a global array

    const recursivelyGetAllPlaylists = function (url) {
        return new Promise((resolve, reject) => {
            callSpotify(url).then(async res => {
                res.items.forEach((playlist, index) => {
                    if(checkPlaylist(playlist)) {
                        playlist_objects.push(playlist);
                    }
                    progressBarHandler({current_operation:index + res.offset + 1, total_operations:res.total, stage:1});
                });
                
                //if we have more playlists to get...
                if(res.next) await recursivelyGetAllPlaylists(res.next);
                //await should wait until all promises complete
                resolve("finished with getUserPlaylists");
            }).catch(err => {
                console.log("error in getUserPlaylists... attempting to fix recursively", err);
                if (okToRecursivelyFix(err)) return new Promise((resolve, reject) => {
                        setTimeout(() => resolve(recursivelyGetAllPlaylists(url)), 500); //wait half a second before calling api again
                    }) //.then(res=>resolve(res)).catch(err=>reject(err)); //this needs to be at the end of every nested promise
                    .then(res => res).catch(err => err); //we have to return the vals because we're not in a promise atm, we're in a .catch callback
                else return err; //do something for handling errors and displaying it to the user
            });
        });
    }

    //the recursive function returns a promise
    return recursivelyGetAllPlaylists("https://api.spotify.com/v1/me/playlists?limit=50");
};

/**
 * Retrieves all tracks from a playlist and adds them to a global array. Ignores local files
 * 
 * @param {string} playlist_id - The ID of the playlist to retrieve tracks from
 * @return {promise} - A promise that resolves with an array of tracks (only uris and explicitness) from the requested playlist
 */
const getAllPlaylistTracks = function (playlist_id) {
    let options = {
        fields:"next,items.track(uri,id,explicit,is_local,name,artists,type)",
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

const getPlaylistTracks = async function (playlist_id = '') {
    //returns an array of all the tracks from a single, given playlist
    try {
        return await getAllPlaylistTracks(playlist_id).then((res_obj) => res_obj.playlist_songs);
    } catch (err) {
        console.log(`Error in getPlaylistTracks try-catch block:`, err);
        throw err;
    }
};

/**
 * Filters an array of tracks against a set of global options
 * 
 * @param {array} track_array - The array of tracks to filter
 * @return {array} - A filtered array of tracks
 */
const filterTracks = function (track_array = global_playlist_tracks) {
    //idea is to minimize the amount of work we perform
    //remove duplicates first that way we aren't filtering thru songs that would've just ended up being removed later on
    progressBarHandler({current_operation:1, total_operations:2, stage:3});
    let filtered_array = [...track_array];  //properly copy array
    if(!USER_OPTIONS.allow_duplicates) filtered_array = filtered_array.reduce((acc, cur) => {
        !acc.find(v => v.uri === cur.uri) && acc.push(cur);
        return acc;
    }, []);
    if(!USER_OPTIONS.allow_explicits) filtered_array = filtered_array.filter(track=>!track.explicit);
    progressBarHandler({current_operation:2, total_operations:2, stage:3});
    return filtered_array;
};

const createPlaylist = function (params = { name: "New Playlist" }) {
    //create a playlist with the given params, and return the created playlist
    return new Promise((resolve, reject) => {
        var url = "https://api.spotify.com/v1/users/" + spotify_credentials.uid + "/playlists";
        postSpotify(url, params, function (ok, playlist) {
            if (ok) resolve(playlist);
            else {
                console.log("err in createPlaylist... will attempt to recursively fix", playlist);
                if (okToRecursivelyFix(playlist)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(createPlaylist(params)), 500); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(err => reject(err)); //this needs to be on the end of every nested promise
                else reject(playlist); //do something for handling errors and displaying it to the user
            }
        });
    });
};

const prepTracksForPlaylistAddition = function (track_array = global_playlist_tracks) {
    //prepares an array of songs for addition to a spotify playlist
    //by sorting them into arrays of 100 songs each, then returning
    //an array that contains all of those 100-song arrays

    //shuffle the given array, then truncate it
    let shuffledArray = shuffleArray(track_array);
    let tmparry = [];
    for (let i = 0; i < shuffledArray.length; i++) { //for every element in track_array
        if (i % 100 == 0) {
            //console.log(i);
            //console.log(uri_array);
            tmparry.push([]); //if we've filled one subarray with 100 songs, create a new subarray
        }
        tmparry[tmparry.length - 1].push(shuffledArray[i].uri); //go to the last subarray and add a song
        //repeat until we've gone thru every song in randomSongArray
    }
    if(tmparry.length > 10000) tmparry.length = 10000;    //truncate
    return tmparry;
};

const addTracksToPlaylist = function (playlist_obj, uri_array) {
    //uri_array needs to be less than 101, please make sure you've checked that before
    //you call this function, otherwise it will err

    //so... what about duplicates?
    var pid = Math.floor(Math.random() * 999);
    console.log(`${pid}: attempting to add ${uri_array.length} tracks to playlist ${playlist_obj.name}`);
    console.log(`${pid}: uri_array:`, uri_array);
    return new Promise((resolve, reject) => {
        //let findDuplicates = arr => arr.filter((item, index) => arr.indexOf(item) != index);
        //var asd = findDuplicates(uri_array).length;
        //if(asd > 0) {
        //    console.log(asd +" duplicates found");
        //    reject({err:"duplicates!!!"});
        //}

        const url = "https://api.spotify.com/v1/users/" + playlist_obj.owner.id + "/playlists/" + playlist_obj.id + '/tracks';
        postSpotify(url, {
            uris: uri_array
        }, (ok, data) => {
            data.pid = pid;
            if (ok) {
                console.log(`${pid}: successfully added ${uri_array.length} tracks to playlist ${playlist_obj.name}`);
                //oldProgressBarHandler();
                resolve({data:data, playlist_obj: playlist_obj, uri_array:uri_array});  //resolve an obj for progressBar purposes
            } else {
                console.log(`${pid} error adding ${uri_array.length} tracks to playlist ${playlist_obj.name}.. attempting to fix recursively...`);
                if (okToRecursivelyFix(data)) return new Promise((resolve, reject) => {
                    setTimeout(() => resolve(addTracksToPlaylist(playlist_obj, uri_array)), 500); //wait half a second before calling api again
                }).then(res => resolve(res)).catch(err => reject(err)); //this needs to be at the end of every nested promise
                else reject(data); //do something for handling errors and displaying it to the user
            }
        });

        //resolve("error: bypassed await...");
    });
};

const addTracksToPlaylistHandler = function (playlist, uri_array) {
    let pending_addTracksToPlaylist_calls = []; //create a promise array
    console.log("starting API batch addTracksToPlaylist calls");
    return new Promise((resolve, reject) => {
        var uri_batch_index = 0,
            current_uri_batch,
            stagger_api_calls = setInterval(() => {
                current_uri_batch = uri_array[uri_batch_index];
                if (uri_batch_index >= uri_array.length) { //once we've reached the end of the uri_array
                    console.log("stopping API batch addTracksToPlaylist calls");
                    clearInterval(stagger_api_calls);
                    //resolve all the api calls, then do something with all the resolved calls
                    //"return" b/c the code will otherwise continue to make anotehr api call
                    return resolvePromiseArray(pending_addTracksToPlaylist_calls, (err, finished_api_calls) => {
                        console.log(err, finished_api_calls);
                        if (err) { // do something if i migrate this to its own function
                            console.log("error in API batch add function", finished_api_calls);
                            reject(finished_api_calls);
                        } //else would be redundant?
                        finished_api_calls.forEach(res => {
                            if (!res || !res.snapshot_id) { //if no snapshot... maybe change this to a customErrorKey or something?
                                console.log("no snapshot found, rejecting promise", res);
                                reject(finished_api_calls);
                            }
                        });
                        console.log("resolving addTracksToPlaylistHandler promise");
                        resolve("resolving from inside addTracksToPlaylistHandler");
                    });
                }
                //if we still have more tracks to add:
                console.log("calling api to addTracksToPlaylist uri_batch number " + uri_batch_index);
                pending_addTracksToPlaylist_calls.push(addTracksToPlaylist(playlist, current_uri_batch).then(resObj => {
                    progressBarHandler({ current_operation:uri_array.findIndex(uri_batch => uri_batch == resObj.uri_array)+1, total_operations:uri_array.length, stage:5 });
                    return resObj.data;
                })); //no .catch() after addTracksToPlaylist b/c we want the error to appear in the callback, causing a reject to send to our main() function
                uri_batch_index++;
            }, REFRESH_RATE.addTracksToPlaylist);
    });
};

const main = async function () {
    //reset global stuff
    playlist_objects = [], global_playlist_tracks = [];
    CURRENTLY_RUNNING = true;
    try {
        //progressBarHandler({remaining_tracks:tracks_to_receive, total_tracks:track_count}); //get a progressbar visual up for the user
        let new_session = database.ref('playlistscrobbler/sessions').push();
        new_session.set({
            sessionTimestamp:new Date().getTime(),
            sessionID:new_session.key,
            //sessionStatus:"pending",
            spotifyUID:spotify_credentials.uid,
            userAgent: navigator.userAgent
        }, function (error) {
            if(error) console.log("Firebase error", error);
            else console.log("Firebase data written successfully");
        });
        console.log("retrieving user playlists...");
        await getUserPlaylists();   //puts a simplified playlist obj for each playlist the into playlist_objects array
        console.log("finished retrieving user playlists!", playlist_objects);
        //now we need to retrieve a random track from each album
        console.log("retrieving songs from each playlist...");
        for(let idx=0, playlist_obj=playlist_objects[idx]; idx < playlist_objects.length; playlist_obj=playlist_objects[++idx]) {
            progressBarHandler({current_operation:idx+1, total_operations:playlist_objects.length, stage:2, playlist_name:playlist_obj.name});
            let track_res = await getPlaylistTracks(playlist_obj.id);
            for(const item of track_res) global_playlist_tracks.push(item.track);
        };
        console.log("finished retrieving songs from each playlist!", global_playlist_tracks);

        console.log("filtering songs based off user's options...");
        //run checks on the track array
        let filtered_tracks = filterTracks(global_playlist_tracks);
        console.log("finished filtering songs", filtered_tracks);

        //time to add the songs to the playlist
        //first, create the playlist, storing the returned obj locally:
        console.log("creating new playlist...");
        progressBarHandler({current_operation:1, total_operations:2, stage:4});
        //var is intentional so it can be used in catch block
        var playlist = await createPlaylist({
            name: playlist_title,
            description: "A combination of all my other playlists made using www.glassintel.com/elijah/programs/spotifyplaylistscrobbler"
        });
        console.log("new playlist succesfully created");
        progressBarHandler({current_operation:2, total_operations:2, stage:4});
        //prep songs for addition (make sure there aren't any extras and put them in subarrays of 100)
        let prepped_uri_array = prepTracksForPlaylistAddition(filtered_tracks);
        console.log("finished preparing songs for addition to the playlist!", prepped_uri_array);
        //add them to the playlist
        console.log("adding songs to playlist...");
        await addTracksToPlaylistHandler(playlist, prepped_uri_array);
        console.log("finished adding songs to playlist!");
    } catch (e) {
        console.log("try-catch err", e);
        progressBarHandler({stage: 'error'});  //change progressbar to red
        alert("The program enountered an error");
        //"delete" the playlist we just created
        //playlists are never deleted on spotify. see this article: https://github.com/spotify/web-api/issues/555
        deleteSpotify(`https://api.spotify.com/v1/playlists/${playlist.id}/followers`, function (ok, res) { //yay nesting callbacks!!
            if (ok) console.log("playlist succesfully deleted");
            else console.log(`unable to delete playlist, error: ${res}`);
        });
        return;
    } finally {
        CURRENTLY_RUNNING = false;
        console.log("execution finished!");
    }
    progressBarHandler({stage: "done"});    //this is outside of the finally block to ensure it doesn't get executed if we trigger a return statement
};

$(document).ready(async function () {
    console.log(`Running Spotify Playlist Scrobbler version ${CURRENT_VERSION}\nDeveloped by Elijah O`);
    //firebase.initializeApp(credentials.firebase.config);
    //database = firebase.database();
    await performAuthDance();
});

$("#spotify-login-button").click(loginWithSpotify);
$("#lastfm-login-button").click(loginWithLastfm);

$("#combine-button").click(function () {
    if(CURRENTLY_RUNNING) return alert("Program is already running!");

    //reset all user options to their default
    USER_OPTIONS.resetOptions();

    //update user options
    let user_options_array = $('#user-options input:checkbox').map(function () {
        return {
            name: this.name,
            value: this.checked ? true : false
        };
    });
    for (const option of user_options_array) USER_OPTIONS.setOption(option.name, option.value);

    //get the playlist title
    if ($("#title-input").val() == "") playlist_title = $("#title-input").attr("placeholder"); //user left placeholder title
    else playlist_title = $("#title-input").val();  //otherwise take the user's title

    $("#progress-bar-wrapper").removeClass("hidden"); //show progress bar
    progress_bar.set(0);    //reset progressbar
    //reset global variables
    main();
});