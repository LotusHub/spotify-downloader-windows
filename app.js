var config = {
	port: 1717,
	version: 173,
	sys: 'win'
}

var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io').listen(server, { log: false });
var spotify_web = require('spotify-web');
var fs = require('fs');
var async = require('async');
var request = require('request');
var https = require('https');
var nodeID3 = require('node-id3');
//var pongWorker = require('./pingpong/pongWorker.js');
var os = require('os');

// Route and Create server
app.use( '/', express.static( __dirname + '/www/') );
app.use('/pingpong', express.static( __dirname + '/pingpong/'));
server.listen(config.port);
console.log('Server is running @ localhost:' + config.port);

if(os.platform() == 'win32') {
	require('child_process').exec("start http://localhost:1717");
} else if(os.platform() == 'darwin') {
	require('child_process').exec("open http://localhost:1717");
} else {
	console.log("Open http://localhost:" + config.port + " in your browser");
}

//Clear log file
fs.writeFileSync('log.txt', "");
//Clear image folder
clearImages();

//FLASH WORKER
var workers = [];

var pingSchema = /^\d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+ \d+$/;

app.get('/pingpong/worker/*', function(req, res) {
	var headerSent = false;
	if(!io.sockets.connected[workers[0].id]) {
		workers.splice(workerId, 1);
		log("Worker disconnected: " + workerId);
	}
    var encodedPing = req.params["0"];
    var ping = encodedPing.replace(/-/g, ' ');
    res.setHeader('Content-type', 'application/json');
    if (!pingSchema.test(ping)) {
        res.send('{"status":201}');
        headerSent = true;
        return;
    }
    if(workers.length == 0) {
    	log("No workers available");
    	console.log("Login fehlgeschlagen. Kein Flash Player aktiviert.");
    	res.send('{"status":201}');
    	headerSent = true;
    	return;
    }

    workers[0].on('pong', function(data) {
    	var msgParts = data.pong.split(':');
        var ping = msgParts[0];
        var pong = msgParts[1];
        if(pong === '') {
        	log("Can't communicate with Flash Player");
        	console.log("Login fehlgeschlagen. Kein Flash Player aktiviert.");
        	res.send('{"status":201}');
        	headerSent = true;
        } else {
        	var encodedPong = pong.replace(/ /g, '-');
        	if(!headerSent) {
	        	res.send('{"status":100,"ping":"' + encodedPing + '","pong":"' + encodedPong + '"}');
	        	headerSent = true;
	    	} else {
	    		log("Flash worker error (Headers already sent)");
	    	}
	    }
    });
    workers[0].emit('ping_pong', {ping: ping});
});

io.sockets.on('connection', function (socket) {
	socket.emit("requestLogin", {});
	var workerId = (workers.push(socket) - 1);
	log("New worker connected: " + workerId);
	socket.on('disconnect', function() {
		workers.splice(workerId, 1);
		log("Worker disconnected: " + workerId);
	});

	socket.on('update_request', function(data) {
        request('www.update_server.tld', function(error, response, body) {
            if (!error && response.statusCode == 200) {
                if(body.indexOf('update_obj') == -1) {
                    console.log("Serverfehler");
                    socket.emit('update_request', {});
                    return;
                }
                var parseString = body.substring(body.indexOf('update_obj') + 10);
                parseString = parseString.substring(0, parseString.indexOf('}') + 1);
                var object = JSON.parse(parseString);
                if(object.newest_version > config.version) {
                    socket.emit('update_request', {url: object['download_' + config.sys]});
                } else {
                    socket.emit('update_request', {});
                }
            } else {
                console.log("Update-Server nicht verfügbar")
                socket.emit('update_request', {});
            }
        });
    })

	var queueWorker = function() {
		if(socket.downloadWorker != null || socket.downloadQueue.length == 0) {
			return;
		}
		socket.downloadWorker = socket.downloadQueue[0];

		if(socket.downloadWorker.type == "track") {
			downloadTrack(socket.downloadWorker.uri, socket.downloadWorker.settings, function(downloadInfo) {
				if(downloadInfo.success) {
					socket.downloadWorker.downloaded++;
				} else {
					socket.downloadWorker.failed++;
				}
				socket.emit("updateQueue", socket.downloadWorker);
				socket.downloadQueue.shift();
				socket.downloadWorker = null;
				queueWorker();
			});
		} else if (socket.downloadWorker.type == "playlist") {
			socket.spotify.playlist(socket.downloadWorker.uri, 0, -1, function(err, playlist) {
				for(var i = 0; i < playlist.contents.items.length; i++) {
					playlist.contents.items[i] = playlist.contents.items[i].uri;
				}
				socket.downloadWorker.playlistContent = playlist.contents.items;
				socket.downloadWorker.settings.path = playlist.attributes.name;
				async.eachSeries(socket.downloadWorker.playlistContent, function(uri, callback) {
					log("Initiate download of track: " + uri);
					socket.downloadWorker.settings.playlist = {
						position: socket.downloadWorker.playlistContent.indexOf(uri),
						fullSize: socket.downloadWorker.playlistContent.length
					};
					downloadTrack(uri, socket.downloadWorker.settings, function(downloadInfo) {
						if(downloadInfo.success) {
							socket.downloadWorker.downloaded++;
						} else {
							socket.downloadWorker.failed++;
						}
						socket.emit("updateQueue", socket.downloadWorker);
						callback();
					});
				}, function(err) {
					console.log("Playlist finished: " + playlist.attributes.name);
					log("Playlist finished: " + playlist.attributes.name);
					socket.downloadQueue.shift();
					socket.downloadWorker = null;
					queueWorker();
				});
			});
		} else if (socket.downloadWorker.type == "album") {
			socket.spotify.get(socket.downloadWorker.uri, function(err, album) {
				var allTracks = [];
				album.disc.forEach(function(disc) {
					if(!Array.isArray(disc.track)) return;
					allTracks.push.apply(allTracks, disc.track);
				});
				for(var i = 0; i < allTracks.length; i++) {
					allTracks[i] = spotify_web.gid2uri('track', allTracks[i].gid);
				}
				socket.downloadWorker.playlistContent = allTracks;
				socket.downloadWorker.settings.path = album.label + " - " + album.name;
				socket.downloadWorker.settings.tagPosition = true;
				async.eachSeries(socket.downloadWorker.playlistContent, function(uri, callback) {
					log("Initiate download of track: " + uri);
					socket.downloadWorker.settings.playlist = {
						position: socket.downloadWorker.playlistContent.indexOf(uri),
						fullSize: socket.downloadWorker.playlistContent.length
					};
					downloadTrack(uri, socket.downloadWorker.settings, function(downloadInfo) {
						if(socket.downloadWorker.countPerAlbum) {
							callback();
							return;
						}
						if(downloadInfo.success) {
							socket.downloadWorker.downloaded++;
						} else {
							socket.downloadWorker.failed++;
						}
						socket.emit("updateQueue", socket.downloadWorker);
						callback();
					});
				}, function(err) {
					if(socket.downloadWorker.countPerAlbum) {
						socket.downloadWorker.downloaded++;
						if(socket.downloadQueue.length > 1 && socket.downloadQueue[1].id == socket.downloadWorker.id) {
							socket.downloadQueue[1].downloaded = socket.downloadWorker.downloaded;
						}
						socket.emit("updateQueue", socket.downloadWorker);
					}
					console.log("Album finished: " + album.name);
					log("Album finished: " + album.name);
					socket.downloadQueue.shift();
					socket.downloadWorker = null;
					queueWorker();
				});
			});
		}
	}

	socket.on('login', function(data) {
		log("Login requested");
		spotify_web.login(data.username, data.password, function(err, spotify) {
			if(err) {
				socket.emit("login", {success: false});
				log("Couldn't login: " + err);
				return;
			} else {
				socket.spotify = spotify;
				socket.downloadQueue = [];
				socket.downloadWorker = null;
				socket.emit("login", {success: true});
				log("Login successful");
			}
			//Get user playlists
			spotify.rootlist(function(err, rootlist) {
				var playlists = [];
				for(var i = 0; i < rootlist.contents.items.length; i++) {
					(function(i) {
						spotify.playlist(rootlist.contents.items[i].uri, 0, -1, function(err, playlist) {
							var obj = {
								title: playlist.attributes.name,
								tracks: playlist.length,
								uri: rootlist.contents.items[i].uri
							}
							playlists.push(obj);
							if((i + 1) == rootlist.contents.items.length) {
								socket.emit('rootlist', {items: playlists});
							}
						});
					})(i);
				}
			});
		});
	});

	socket.on("search", function(data) {
		socket.spotify.search(data.title, function(err, searchXML) {
			if(err) {
				log("Couldn't search for: " + data);
				log("Search error: " + err);
				return;
			}
			socket.emit("search", {xml: searchXML});
		});
	});

	socket.on("addToQueue", function(data) {
		if(data.item.type == "playlist") {
			socket.spotify.playlist(data.item.uri, 0, -1, function(err, playlist) {
				if(err) {
					return;
				}
				data.item.size = playlist.length;
				data.item.name = playlist.attributes.name;
				socket.emit("addToQueue", data);
				socket.downloadQueue.push(data.item);
				queueWorker();
			});
		} else if(data.item.type == "album") {
			socket.spotify.get(data.item.uri, function(err, album) {
				if(err) {
					return;
				}
				data.item.size = 0;
				album.disc.forEach(function(disc) {
					if(!Array.isArray(disc.track)) return;
					data.item.size += disc.track.length;
				});
				data.item.name = album.name;
				socket.emit("addToQueue", data);
				socket.downloadQueue.push(data.item);
				queueWorker();
			});
		} else if(data.item.type == "track") {
			socket.spotify.get(data.item.uri, function(err, track) {
				if(err) {
					return;
				}
				data.item.name = track.name;
				socket.emit("addToQueue", data);
				socket.downloadQueue.push(data.item);
				queueWorker();
			});
		} else if(data.item.type == "artist") {
			data.artistId = data.item.uri.substring(data.item.uri.lastIndexOf(":") + 1);
			getArtist(data.artistId, function(err, artist) {
				getArtistAlbums(data.artistId, function(err, albums) {
					if(err) {
						return;
					}
					data.item.size = albums.length;
					data.item.name = artist.name + " (ARTIST)";
					for(var i = 0; i < albums.length; i++) {
						albums[i].countPerAlbum = true;
						albums[i].id = data.item.id;
						albums[i].size = data.item.size;
						albums[i].downloaded = data.item.downloaded = 0;
        				albums[i].failed = data.item.failed = 0;
        				albums[i].settings = data.item.settings;
						socket.downloadQueue.push(albums[i]);
					}
					socket.emit("addToQueue", data);
					queueWorker();
				});
			});
		} else {
			console.log("Unsupported type: " + data);
			log("Unsupported type: " + data);
			return;
		}
	});

	function downloadTrack(uri, settings, callback) {
		log("Get metadata for track: " + uri);
		socket.spotify.get(uri, function(err, track) {
			if(err) {
				log("Error getting metadata for track: " + uri);
				callback({success: false, error: err});
				return;
			}

			if(!checkTrack(track, socket.spotify.country, socket.spotify)) {
				log("Can't get track: " + uri);
				callback({success: false, error: "Track not available"});
				return;
			}

			settings = settings || {};

			var metadata = {
				title: fixName(track.name),
				artist: fixName(track.artist[0].name),
				album: fixName(track.album.name)
			}

			if(track.album.artist && track.album.artist[0].name) metadata.performerInfo = fixName(track.album.artist[0].name);
			if(track.album.date && track.album.date.year) metadata.year = track.album.date.year + "";
			if(track.number) metadata.trackNumber = track.number + "";

			if(settings.tagPosition) {
				metadata.trackNumber = track.number + "/" + settings.playlist.fullSize;
			}
			
			if(track.album.coverGroup && track.album.coverGroup.image.length != 0) {
				metadata.image = 'https://d3rt1990lpmkn.cloudfront.net' + '/300/' + gid2id(track.album.coverGroup.image[0].fileId);
				if(track.album.coverGroup.image[2]) metadata.image = 'https://d3rt1990lpmkn.cloudfront.net' + '/640/' + gid2id(track.album.coverGroup.image[2].fileId);
			}

			var filename = metadata.artist + " - " + metadata.title;
			if(settings.filename != "" && settings.filename) {
				filename = settingsRegex(metadata, settings.filename, settings.playlist);
			}

			var filepath = __dirname + '/mp3/';
			if(settings.path) {
				filepath = __dirname + '/mp3/' + fixName(settings.path, true) + '/';
			}
			//Create folder if doesn't exist
	        if( !fs.existsSync(filepath) ) {
				fs.mkdirSync(filepath);
			}
			writePath = filepath + fixName(filename, true) + '.mp3';

			//Check if already exists
			if(!fs.existsSync(writePath)) {
				var writeStream = fs.createWriteStream(writePath);
			} else {
				console.log("Already downloaded: " + metadata.artist + ' - ' + metadata.title)
				callback({success: true, error: "Already downloaded"});
				return;
			}

			var trackId = uri.replace('spotify:track:', '');

			//Get image
			if(metadata.image) {
				var imagefile = fs.createWriteStream(__dirname + "/img/" + fixName(metadata.title, true) + ".jpg");
				https.get(metadata.image, function(response) {
					if(!response) {
						metadata.image = undefined;
						return;
					}
					response.pipe(imagefile);
					metadata.image = (__dirname + '/img/' + fixName(metadata.title, true) + ".jpg").replace(/\\/g, "/");
				});
			}

			log("Start track download: " + uri);

			var song = track.play();
			song.on("finish", function() {
				log("Track download finished: " + uri);
				if(settings.m3uFile && settings.playlist) {
					fs.appendFileSync(filepath + "playlist.m3u", filename + ".mp3\r\n");
				}
				console.log("Downloaded: " + metadata.artist + " - " + metadata.title);

				//Write ID3-Tags
				if(!nodeID3.write(metadata, writePath)) {
					log("Couldn't tag: " + uri);
				}

				callback({success: true, error: null});

			});
			socket.on("error", function(err) {
				writeStream.end();
				log("Track download unsuccessful: " + err)
				fs.unlinkSync(writePath);
				if(err.code == 8) {
                    console.log("Spotify needs to cool down (20s)...");
                    setTimeout(function(){
                        downloadTrack(uri, settings, callback);
                    }, 20 * 1000);
                } else {
                    console.log("Couldn't handle error, skipping song: " + metadata.artist + ' - ' + metadata.title);
                    callback({success: false, error: err})
                }
			});
			song.pipe(writeStream);
		});
	}
});

function getArtistAlbums(artistId, next, callback) {
	if(!artistId) { callback(new Error("No artistId provided")); return; }
	if(!callback) {
		callback = next;
		next = [];
	}
	var url = "https://api.spotify.com/v1/artists/" + artistId + "/albums"
	var offset = next.length;
	var limit = 50;

	request(url + "?limit=" + limit + "&offset=" + offset, function(error, response, body) {
    	if (!error && response.statusCode == 200) {
    		var content = JSON.parse(body);
    		if(!content.items) {
    			callback(new Error("API Error"));
    			return;
    		}
    		next = next.concat(content.items);

    		if(next.length < content.total) {
    			getArtistAlbums(artistId, next, callback);
    			return;
    		}

    		callback(null, next);
    	} else {
    		callback(new Error("Couldn't get albums"));
    		return;
    	}
    });
}

function getArtist(artistId, callback) {
	if(!artistId) { callback(new Error("No artistId provided")); return; }
	var url = "https://api.spotify.com/v1/artists/" + artistId;

	request(url, function(error, response, body) {
    	if (!error && response.statusCode == 200) {
    		var content = JSON.parse(body);
    		if(!content.name) {
    			callback(new Error("API Error"));
    			return;
    		}

    		callback(null, content);
    	} else {
    		callback(new Error("Couldn't get artist"));
    		return;
    	}
    });

}

var specialCharTable = 	["ç", "Ç", "ğ", "Ğ", "ı", "I", "i", "İ", "ş", "Ş"];
var specialCharTo = 	["c", "C", "g", "G", "i", "I", "i", "I", "s", "S"];

var fixName = function(input, file) {
	var regEx = new RegExp('[,/\\\\:*?""<>|]', 'g');
	if(!file) {
		regEx = new RegExp('[/\\\\""<>|]', 'g');
	}
	var fixedName = input.replace(regEx, '_');
	for(var i = 0; i < specialCharTable.length; i++) {
		regEx = new RegExp(specialCharTable[i], 'g');
		fixedName = fixedName.replace(regEx, specialCharTo[i]);
	}
	while(fixedName && fixedName.slice(-1) === ".") { 
		fixedName = fixedName.slice(0, -1);
	}
	return fixedName;
}

function checkTrack(track, country, spotify) {
	if (spotify.isTrackAvailable(track, country)) {
	    return true;
	} else if (Array.isArray(track.alternative)) {
	    var tracks = track.alternative;
	    for (var i = 0; i < tracks.length; i++) {
	        track = tracks[i];
	        if (spotify.isTrackAvailable(track, country)) {
	            return true;
	        }
	    }
	} else {
		return false;
	}
}

function log(string) {
	var date = new Date();
	fs.appendFileSync('log.txt', "[" + date.toLocaleDateString('de') + " - " + date.toLocaleTimeString('de') + "] " + string + "\r\n");
}

function clearImages() {
	//Remove all images
	var image_folder_path = __dirname + "/img";
	if( fs.existsSync(image_folder_path) ) {
	  fs.readdirSync(image_folder_path).forEach(function(file,index){
	    var curPath = image_folder_path + "/" + file;
	      fs.unlinkSync(curPath);
	  });
	  fs.rmdir(image_folder_path, function(err) {
	      fs.mkdirSync(__dirname + "/img");
	  });
	} else {
	    fs.mkdirSync(__dirname + "/img");
	}
}

function settingsRegex(metadata, filename, playlist) {
	filename = filename.replace(/%title%/g, metadata.title);
    filename = filename.replace(/%album%/g, metadata.album);
    filename = filename.replace(/%artist%/g, metadata.artist);
    if(playlist) {
    	filename = filename.replace(/%number%/g, pad(playlist.position + 1, playlist.fullSize.toString().length));
    }
    return filename;
}

function gid2id(gid) {
  for (var b = '', c = 0, a = gid.length; c < a; ++c) {
    b += (gid[c] + 256).toString(16).slice(-2);
  }
  return b;
};

function pad (str, max) {
  str = str.toString();
  return str.length < max ? pad("0" + str, max) : str;
}

process.on('uncaughtException', function (err) {
  log(err);
  console.trace(err);
});
