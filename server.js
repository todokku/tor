"use strict";

let fs = require("fs"),
    path = require("path"),
    http = require('http'),
    classifier = require('./classifier.js'),
    latest = require('./latest.js'),
    QueryHandler = require('./queryHandler')

let indexersDir = path.dirname(require.main.filename) + "/indexers"
let indexerObjects = []

/*
  TODO!
  - Use express.js for some sligltly neater URL handling.
  - Add output compression (comes with express.js)
  - Allow json output fields to be managed by the request side (in the url).
    <url>/search/<some query>/fields:name,url,size
    An url like that should only add the fields name, url and size to the output,
    the others (sizeHumanReadable and classification) won't be printed.
  - Allow requesting the avaliable indexers. Could be done via the url:
    <url>/indexers
  - Allow the request to not use certain indexers, could be an url like:
    <url>/search/<some query>/skipIndexers:kickass.js,rarbg.js,...
  - Describe the API usage on some page. <url>/documentation seems ok.
*/

// Crazy code..
// "stolen" from http://stackoverflow.com/a/20463021
function fileSizeIEC(a,b,c,d,e){
 return (b=Math,c=b.log,d=1024,e=c(a)/c(d)|0,a/b.pow(d,e)).toFixed(2)
 +' '+(e?'KMGTPEZY'[--e]+'iB':'Bytes')
}

fs.readdir(indexersDir, function (err, files) {
  if (err) {
    throw err;
  }

  console.log("Loading indexers:")

  for(let file of files) {
    let indexerFile = indexersDir + "/" + file
    console.log(" - " + file)
    indexerObjects.push(require(indexerFile))
  }

  // 2 is the fist argument after "node server.js"
  if (process.argv[2]) {
    handleRequest(0, 0, process.argv[2])
  }
});

// From: http://stackoverflow.com/questions/31424561/wait-until-all-es6-promises-complete-even-rejected-promises
Promise.allSettled = function (promises) {
  return Promise.all(promises.map(p => Promise.resolve(p).then(v => ({
    state: 'fulfilled',
    value: v,
  }), r => ({
    state: 'rejected',
    reason: r,
  }))));
};

let meta = {};

function handleRequest(request, response, commandlineKeyword = null) {
  console.log("..handleRequest")
  let keyword = (commandlineKeyword != null) ? commandlineKeyword : request.url;
  let results = keyword.match(/(\/search\/?)?((latest: ?)?(.*))/i);
  keyword = decodeURIComponent(results[2].trim());

  // Handle empty search keyword. Return if empty.
  if (!keyword || keyword.length < 2) {
    handleResponse(response, {error: "Empty search keyword. Please type in a search keyword!"});
    return;
  }

  let handler = new QueryHandler();
  handler.parse(keyword).then(values => {
    meta = values.meta;
    fetchDataAndSendRequest(response, values.searchString);
  }).catch(reason => {
    meta = reason.meta
    keyword = decodeURIComponent(results[4].trim())
//    console.log(results)
//    console.log(`We tried to search for: ${keyword}`)
    // Search for whatever was given (index 4 of the matches!)
    fetchDataAndSendRequest(response, keyword);
  });
}

function fetchDataAndSendRequest(response, keyword) {
  console.log("..fetchDataAndSendRequest")
  // Tell the indexers which thing to look for.
  let indexerPromises = []
  for (let indexer of indexerObjects) {
    indexer.searchString = keyword
    indexerPromises.push(indexer.execute())
  }

  Promise.allSettled(indexerPromises)
  .then((data) => {
    let outputData = prepareOutputData(data);

    if (Object.keys(outputData).length == 0) {
      outputData['error'] = `No results for query: ${keyword}`
    } else {
      outputData['meta'] = meta;
    }

    handleResponse(response, outputData);
  })
  .catch((err) => {
    console.log(err);
  });
}

function handleResponse(response, data) {
  console.log("..handleResponse")
  // If we have a response object (we probably have an http request) so return to that.
  // If we don't then we're on the console.
  if (response) {
    // We send our content as application/json
    response.writeHead(200, {'Content-Type': 'application/json'});

    // null, 4 -- this is to have nice json formatting.
    response.end(JSON.stringify(data, null, 4))
  } else {
    console.log(data)
    process.exit(0);
  }
}

function prepareOutputData(data) {
  console.log("..prepareOutputData")
  // First filter the objects to only get the data of those that have values.
  let uniqueInfohashes = new Set()
  let filteredData = []
  for (let objData of data) {
    if (objData.state == "fulfilled") {
      // Iterate over the arrays and filter for unique.
      for (let obj of objData.value) {
        let infohash = obj.url.match(/\burn:btih:([A-F\d]+)\b/i)[1].toLowerCase()

        if (!uniqueInfohashes.has(infohash)) {
          filteredData.push(obj)
          uniqueInfohashes.add(infohash)
        }
      }
    }
  }

  // Here filteredData contains all unique terrents. It might still contains too much though. That is filtered out next.
  let name = meta.name.replace(/[\\/:*?\"<>|]/, ' ').toLowerCase();

  if (meta.season) {
    name += ` s${meta.season}e${meta.episode}`
  }

  let names = name.replace(/\s\s+/g, ' ').split(' ');

  // Whatever is in the names array, must occur in the name of the torrent.
  filteredData = filteredData.filter((obj) => {
    for (let namePart of names) {
      if (obj.name.toLowerCase().indexOf(namePart) < 0) {
        return false;
      }
    }
    return true;
  })

  // Sort the filteredData by size. This also makes it sorted in the outputData list.
  filteredData.sort(function(a, b) {
    return parseFloat(b.size) - parseFloat(a.size);
  });

  // The data - as is - is now complete. But still rather crude as we don't yet know which quality which item is.
  // So classify every item and put it in the correct outputData array (grouped by resolution).
  let outputData = { "2160p" : [], "1080p": [], "720p" : [], "sd" : [] }

  for (let obj of filteredData) {
      let classification = classifier.classify(obj.name)
      obj.sizeHumanReadable = fileSizeIEC(obj.size)
      obj.classification = classification

      // Add it to the output data.
      outputData[classification.resolution].push(obj)
  }

  // Lastly, remove empty elements
  for (let item in outputData) {
    if (outputData[item].length === 0) {
      delete outputData[item];
    }
  }

  return outputData;
}

//Create a server
let port = 80
let server = http.createServer(function(request, response) {
  // Handle favicon.ico
  if (request.url === '/favicon.ico') {
    response.writeHead(200, {'Content-Type': 'image/x-icon'} );
    response.end();
  } else {
    // Allow javascript sites to request this API.
    if (response)
    {
      response.setHeader("Access-Control-Allow-Origin", "*");
    }
    
    // Handle the request.
    handleRequest(request, response);
  }
});

//Lets start our server
server.listen(port, function(){
    //Callback triggered when server is successfully listening. Hurray!
    console.log("Server listening on: http://localhost:%s", port);
});
