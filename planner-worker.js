'use strict';
importScripts('engine.js','planner.js');
self.onmessage=event=>{try{const {project,options,manual}=event.data;self.postMessage({result:Planner.solve(project,options,manual)});}catch(error){self.postMessage({error:error.message});}};
