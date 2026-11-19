const VERSION='haru-offline-v12';
const CACHE=`haru-${VERSION}`;
const ASSETS=['./','styles.css?v=32','app.js?v=32','icon.svg','manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(key=>key!==CACHE).map(key=>caches.delete(key)));
  await self.clients.claim();
  for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'CACHE_UPDATED',version:VERSION});
})()));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);const scopePath=new URL(self.registration.scope).pathname.replace(/\/$/,'');
  if(event.request.method!=='GET'||url.pathname.startsWith(`${scopePath}/api/`))return;
  event.respondWith((async()=>{
    const cached=await caches.match(event.request);
    const network=fetch(event.request).then(async response=>{if(response.ok)await (await caches.open(CACHE)).put(event.request,response.clone());return response;});
    if(cached){event.waitUntil(network.catch(()=>{}));return cached;}
    try{return await network;}catch{return await caches.match('./');}
  })());
});
