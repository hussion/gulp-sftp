'use strict';
var path = require('path');
var fs = require('fs');
var gutil = require('gulp-util');
var util = require('util');
var through = require('through2');
var Connection = require('ssh2');
var async = require('async');
var parents = require('parents');
var Stream = require('stream');
var assign = require('object-assign');
var streamBuffers= require('stream-buffers');

var normalizePath = function(path){
	return path.replace(/\\/g, '/');
};

//mdrake: TODO - support .key file including private key auth
module.exports = function (options) {
    options = assign({}, options);// credit sindresorhus


	if (options.host === undefined) {
		throw new gutil.PluginError('gulp-sftp', '`host` required.');
	}

	var fileCount = 0;
	var remotePath = options.remotePath || '/';

	
	options.authKey = options.authKey||options.auth;
	var authFilePath = options.authFile || '.ftppass'; 
	var authFile=path.join('./',authFilePath);
	if(options.authKey && fs.existsSync(authFile)){
		var auth = JSON.parse(fs.readFileSync(authFile,'utf8'))[options.authKey];
		if(!auth)
			this.emit('error', new gutil.PluginError('gulp-sftp', 'Could not find authkey in .ftppass'));
		for (var attr in auth) { options[attr] = auth[attr]; }
	}
	
	//option aliases
	options.password = options.password||options.pass;
	options.username = options.username||options.user||'anonymous';
	
	/*
	 * Lots of ways to present key info
	 */
	var key = options.key || options.keyLocation || null;
	if(key&&typeof key == "string")
		key = {location:key};
	
	//check for other options that imply a key or if there is no password
	if(!key && (options.passphrase||options.keyContents||!options.password)){
		key = {};		
	}
	
	if(key){		
		
		//aliases
		key.contents=key.contents||options.keyContents;
		key.passphrase=key.passphrase||options.passphrase;
		
		//defaults
		key.location=key.location||["~/.ssh/id_rsa","/.ssh/id_rsa","~/.ssh/id_dsa","/.ssh/id_dsa"];
		
		//type normalization
		if(!util.isArray(key.location))
			key.location=[key.location];
		
		//resolve all home paths
		if(key.location){
			var home = process.env.HOME||process.env.USERPROFILE;
			for(var i=0;i<key.location.length;i++)
			if (key.location[i].substr(0,2) === '~/')
				key.location[i] = path.resolve(home,key.location[i].replace(/^~\//,""));
		

			for(var i=0,keyPath;keyPath=key.location[i++];){	
				
				
				if(fs.existsSync(keyPath)){
					key.contents = fs.readFileSync(keyPath);		
					break;
				}
			}
		}else if(!key.contents){
			this.emit('error', new gutil.PluginError('gulp-sftp', 'Cannot find RSA key, searched: '+key.location.join(', ')));
		}
		
			
		
	}
	/*
	 * End Key normalization, key should now be of form:
	 * {location:Array,passphrase:String,contents:String}
	 * or null
	 */
	
	if(options.password){
		gutil.log('Authenticating with password.');
	}else if(key){			
		gutil.log('Authenticating with private key.');		
	}
	

	var logFiles = options.logFiles === false ? false : true;


	delete options.remotePath;
	delete options.localPath;
	delete options.user;
	delete options.pass;
	delete options.logFiles;
	
	var mkDirCache = {};

    var finished=false;
    var sftpCache = null;//sftp connection cache
    var connectionCache = null;//ssh connection cache

    var pool = function(uploader){ // method to get cache or create connection

        if(sftpCache)
            return uploader(sftpCache);



        var c = new Connection();
        connectionCache = c;
        c.on('ready', function() {

            c.sftp(function(err, sftp) {
                if (err)
                    throw err;

                sftp.on('end', function() {
                    gutil.log('SFTP :: SFTP session closed');
                    sftpCache=null;
                    if(!finished)
                    this.emit('error', new gutil.PluginError('gulp-sftp', "SFTP abrupt closure"));
                });


                sftpCache = sftp;
                uploader(sftpCache);
            });//c.sftp
        });//c.on('ready')

        c.on('error', function(err) {
            this.emit('error', new gutil.PluginError('gulp-sftp', err));
            //return cb(err);
        });
        c.on('end', function() {
            gutil.log('Connection :: end');
        });
        c.on('close', function(had_error) {
            gutil.log('Connection :: close',had_error!==false?"with error":"");
        });


        /*
         * connection options, may be a key
         */
        var connection_options = {
            host : options.host,
            port : options.port,
            username : options.username
        };
        if(options.password){
            connection_options.password = options.password;
        }else if(key){
            connection_options.privateKey = key.contents;
            connection_options.passphrase = key.passphrase;
        }

        c.connect(connection_options);
        /*
         * end connection options
         */

    };

	return through.obj(function (file, enc, cb) {
		if (file.isNull()) {
			this.push(file);
			return cb();
		}



		// have to create a new connection for each file otherwise they conflict, pulled from sindresorhus



		var finalRemotePath = normalizePath(path.join(remotePath, file.relative));


		
		//connection pulled from pool
		pool(function(sftp){
            /*
             *  Create Directories
             */

            //get dir name from file path
            var dirname=path.dirname(finalRemotePath);
            //get parents of the target dir

            var fileDirs = parents(dirname)
                .map(function(d){return d.replace(/^\/~/,"~");})
                .map(normalizePath);
            //get filter out dirs that are closer to root than the base remote path
            //also filter out any dirs made during this gulp session
            fileDirs = fileDirs.filter(function(d){return d.length>remotePath.length&&!mkDirCache[d];});

            //while there are dirs to create, create them
            //https://github.com/caolan/async#whilst - not the most commonly used async control flow
            async.whilst(function(){
                return fileDirs && fileDirs.length;
            },function(next){
                var d= fileDirs.pop();
                mkDirCache[d]=true;
                //mdrake - TODO: use a default file permission instead of defaulting to 755

                sftp.mkdir(d, {mode: '0755'}, function(err){//REMOTE PATH

                    if(err){
                        //assuming that the directory exists here, silencing this error
                        gutil.log('SFTP error or directory exists:', gutil.colors.red(err + " " +d));
                    }else{
                        gutil.log('SFTP Created:', gutil.colors.green(dirname));
                    }
                    next();
                });
            },function(){

                var stream = sftp.createWriteStream(finalRemotePath,{//REMOTE PATH
                    flags: 'w',
                    encoding: null,
                    mode: '0666',
                    autoClose: true
                });

                //var readStream = fs.createReadStream(fileBase+localRelativePath);

                var uploadedBytes = 0;


                var highWaterMark = stream.highWaterMark||(16*1000);
                var size = file.stat.size;
                if(file.isBuffer()&&size>(200*1000)){
                    //ssh2 seems to close sftp uploads if file is arbitrarily large
                    //convert to stream if file is over 200kb
                    var readableDecoy = new streamBuffers.ReadableStreamBuffer({
                        frequency: 10,
                        chunkSize: highWaterMark
                    });
                    readableDecoy.put(file.contents);
                    readableDecoy.pipe(stream); // start upload
                    stream.on('close',function(){
                        readableDecoy.destroy();
                    });
                }else{

                    file.pipe(stream); // start upload

                }

                stream.on('drain',function(){
                    uploadedBytes+=highWaterMark;
                    gutil.log('gulp-sftp:',finalRemotePath,"uploaded",Math.round((uploadedBytes/size)*100)+"%");
                });




                stream.on('close', function(err) {

                    if(err)
                        this.emit('error', new gutil.PluginError('gulp-sftp', err));
                    else{
                        if (logFiles) {
                            gutil.log('gulp-sftp:', gutil.colors.green('Uploaded: ') +
                                file.relative +
                                gutil.colors.green(' => ') +
                                finalRemotePath);
                        }

                        fileCount++;
                    }
                    return cb(err);
                });

            });//async.whilst
        });
								

		
		this.push(file);

	}, function (cb) {
		if (fileCount > 0) {
			gutil.log('gulp-sftp:', gutil.colors.green(fileCount, fileCount === 1 ? 'file' : 'files', 'uploaded successfully'));
		} else {
			gutil.log('gulp-sftp:', gutil.colors.yellow('No files uploaded'));
		}
        finished=true;
        if(sftpCache)
            sftpCache.end();
        if(connectionCache)
            connectionCache.end();

		cb();
	});
};
