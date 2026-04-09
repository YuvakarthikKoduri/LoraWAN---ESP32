import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import {
  AMARAVATI_POIS,
  Colors,
  MAP_BOUNDS,
  MAP_CENTER,
  VITAP_MAP_BOUNDS,
  VITAP_MAP_CENTER,
  VITAP_POIS,
} from '../constants/config';
import { OFFLINE_TILE_DATA_URIS } from '../constants/offlineTileData';
import { OFFLINE_TILE_MODULES } from '../constants/offlineTiles';
import { GPSPosition } from '../services/apiClient';
import { useApp } from '../services/AppStateContext';

interface TapCoord {
  lat: number;
  lng: number;
}

interface TileGrid {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface MapPreset {
  id: string;
  label: string;
  testBadge: string;
  zoom: number;
  grid: TileGrid;
  center: { lat: number; lng: number };
  bounds: { north: number; south: number; east: number; west: number };
  pois: Array<{ name: string; lat: number; lng: number; icon: string }>;
}

const MAP_PRESETS: MapPreset[] = [
  {
    id: 'amaravati',
    label: 'Amaravati',
    testBadge: 'AMARAVATI TEST',
    zoom: 15,
    grid: { minX: 23709, maxX: 23713, minY: 14859, maxY: 14863 },
    center: MAP_CENTER,
    bounds: MAP_BOUNDS,
    pois: AMARAVATI_POIS,
  },
  {
    id: 'vitap',
    label: 'VIT-AP',
    testBadge: 'VIT-AP TEST',
    zoom: 14,
    grid: { minX: 11854, maxX: 11856, minY: 7429, maxY: 7431 },
    center: VITAP_MAP_CENTER,
    bounds: VITAP_MAP_BOUNDS,
    pois: VITAP_POIS,
  },
];

function hasCoord(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function buildTrackedPositions(
  gpsPositions: GPSPosition[],
  sessionUid: string | undefined,
  sessionName: string | undefined,
  myLat: number | null,
  myLng: number | null
) {
  const tracked = [...gpsPositions];

  if (sessionUid && sessionName && hasCoord(myLat) && hasCoord(myLng)) {
    const index = tracked.findIndex((entry) => entry.uid === sessionUid);
    const me = {
      uid: sessionUid,
      name: `${sessionName} (You)`,
      lat: myLat,
      lng: myLng,
      hasGPS: true,
    };

    if (index >= 0) {
      tracked[index] = me;
    } else {
      tracked.push(me);
    }
  }

  return tracked.filter((entry) => entry.hasGPS);
}

function distanceLabel(lat1: number, lng1: number, lat2: number, lng2: number) {
  const radius = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = radius * c;
  return distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(2)} km`;
}

export default function MapScreen() {
  const { appMode, gpsActive, gpsPositions, myAccuracy, myLat, myLng, session, users } = useApp();
  const webViewRef = useRef<WebView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [tileError, setTileError] = useState('');
  const [tapCoord, setTapCoord] = useState<TapCoord | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<MapPreset>(MAP_PRESETS[0]);
  const [tileDataMap, setTileDataMap] = useState<Record<string, string>>({});
  const [tileDataReady, setTileDataReady] = useState(false);

  const trackedPositions = buildTrackedPositions(
    gpsPositions,
    session?.uid,
    session?.username,
    myLat,
    myLng
  ).map((entry) => ({
    ...entry,
    name:
      entry.uid === session?.uid
        ? `${session?.username || 'You'} (You)`
        : users.find((user) => user.uid === entry.uid)?.name || entry.name || entry.uid,
    isOwn: entry.uid === session?.uid,
  }));

  useEffect(() => {
    let cancelled = false;

    const loadOfflineTiles = async () => {
      const merged: Record<string, string> = { ...OFFLINE_TILE_DATA_URIS };

      const entries = Object.entries(OFFLINE_TILE_MODULES);
      const resolved = await Promise.all(
        entries.map(async ([key, moduleId]) => {
          if (merged[key]) {
            return [key, merged[key]] as const;
          }

          try {
            const asset = Asset.fromModule(moduleId);
            if (!asset.localUri) {
              await asset.downloadAsync();
            }
            const uri = asset.localUri || asset.uri;
            if (!uri) {
              return [key, ''] as const;
            }
            if (uri.startsWith('data:image/')) {
              return [key, uri] as const;
            }

            const file = new FileSystem.File(uri);
            const base64 = await file.base64();
            return [key, `data:image/png;base64,${base64}`] as const;
          } catch {
            return [key, ''] as const;
          }
        })
      );

      resolved.forEach(([key, uri]) => {
        if (uri) {
          merged[key] = uri;
        }
      });

      if (!cancelled) {
        setTileDataMap(merged);
        setTileDataReady(true);
      }
    };

    void loadOfflineTiles();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !webViewRef.current) {
      return;
    }

    const payload = JSON.stringify(trackedPositions);
    webViewRef.current.injectJavaScript(`updateNodes(${payload}); true;`);
  }, [mapReady, trackedPositions]);

  useEffect(() => {
    setMapReady(false);
    setTapCoord(null);
    setTileError('');
  }, [selectedPreset.id]);

  const handleMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'ready') {
        setMapReady(true);
      } else if (data.type === 'tap') {
        setTapCoord({ lat: data.lat, lng: data.lng });
      } else if (data.type === 'tile_status') {
        if (data.missing > 0) {
          const sample = Array.isArray(data.keys) ? data.keys.slice(0, 6).join(', ') : '';
          setTileError(
            `Offline tile load warning: ${data.missing} tile(s) missing.${sample ? ` Keys: ${sample}${data.missing > 6 ? '...' : ''}` : ''}`
          );
        } else {
          setTileError('');
        }
      }
    } catch {
      // Ignore malformed bridge payloads.
    }
  };

  const focusSelf = () => {
    if (session?.uid && webViewRef.current) {
      webViewRef.current.injectJavaScript(`focusNode(${JSON.stringify(session.uid)}); true;`);
    }
  };
  const zoomIn = () => {
    webViewRef.current?.injectJavaScript('zoomIn(); true;');
  };
  const zoomOut = () => {
    webViewRef.current?.injectJavaScript('zoomOut(); true;');
  };
  const resetZoom = () => {
    webViewRef.current?.injectJavaScript('resetZoom(); true;');
  };

  const distToTap =
    tapCoord && hasCoord(myLat) && hasCoord(myLng)
      ? distanceLabel(myLat, myLng, tapCoord.lat, tapCoord.lng)
      : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>OFFLINE MAP</Text>
        {appMode === 'test' ? <Text style={styles.badge}>{selectedPreset.testBadge}</Text> : null}
        <Text style={styles.badge}>{trackedPositions.length} tracked</Text>
        <Text style={[styles.badge, gpsActive && styles.badgeLive]}>{gpsActive ? 'GPS LIVE' : 'GPS OFF'}</Text>
      </View>

      <View style={styles.mapPicker}>
        {MAP_PRESETS.map((preset) => (
          <TouchableOpacity
            key={preset.id}
            style={[styles.mapPresetBtn, selectedPreset.id === preset.id && styles.mapPresetBtnActive]}
            onPress={() => setSelectedPreset(preset)}
          >
            <Text
              style={[
                styles.mapPresetText,
                selectedPreset.id === preset.id && styles.mapPresetTextActive,
              ]}
            >
              {preset.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.subheader}>
        <Text style={styles.coordsText}>
          {hasCoord(myLat) && hasCoord(myLng)
            ? `${myLat.toFixed(6)}, ${myLng.toFixed(6)} (+/-${myAccuracy}m)`
            : 'Waiting for GPS fix'}
        </Text>
        <View style={styles.mapControls}>
          <TouchableOpacity style={styles.centerBtn} onPress={focusSelf}>
            <Text style={styles.centerBtnText}>FOCUS ME</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={zoomOut}>
            <Text style={styles.zoomBtnText}>-</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={zoomIn}>
            <Text style={styles.zoomBtnText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomResetBtn} onPress={resetZoom}>
            <Text style={styles.zoomResetText}>RST</Text>
          </TouchableOpacity>
        </View>
      </View>

      {!tileDataReady ? (
        <View style={styles.loading}>
          <ActivityIndicator color={Colors.accent} size="large" />
          <Text style={styles.loadingText}>Preparing offline tiles...</Text>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          key={selectedPreset.id}
          source={{ html: getMapHTML(selectedPreset, tileDataMap) }}
          style={styles.map}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          startInLoadingState
          renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator color={Colors.accent} size="large" />
            <Text style={styles.loadingText}>
              {appMode === 'test'
                ? `Loading ${selectedPreset.label} test map...`
                : 'Loading offline map...'}
            </Text>
          </View>
          )}
        />
      )}

      {tileError ? (
        <View style={styles.tileWarning}>
          <Text style={styles.tileWarningText}>{tileError}</Text>
        </View>
      ) : null}

      {tapCoord ? (
        <View style={styles.tapCard}>
          <Text style={styles.tapTitle}>TAPPED LOCATION</Text>
          <Text style={styles.tapValue}>
            {tapCoord.lat.toFixed(6)}, {tapCoord.lng.toFixed(6)}
          </Text>
          {distToTap ? <Text style={styles.tapDistance}>{distToTap} from you</Text> : null}
        </View>
      ) : null}

      {trackedPositions.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.bottomStrip}
          contentContainerStyle={styles.bottomStripContent}
        >
          {trackedPositions.map((entry) => (
            <TouchableOpacity
              key={entry.uid}
              style={[styles.nodeChip, entry.isOwn && styles.nodeChipOwn]}
              onPress={() =>
                webViewRef.current?.injectJavaScript(
                  `focusNode(${JSON.stringify(entry.uid)}); true;`
                )
              }
            >
              <Text style={[styles.nodeName, entry.isOwn && styles.nodeNameOwn]}>{entry.name}</Text>
              {hasCoord(myLat) && hasCoord(myLng) && !entry.isOwn ? (
                <Text style={styles.nodeDistance}>
                  {distanceLabel(myLat, myLng, entry.lat, entry.lng)}
                </Text>
              ) : null}
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function getMapHTML(preset: MapPreset, tileDataMap: Record<string, string>) {
  const tileGrid = JSON.stringify(preset.grid);
  const bounds = JSON.stringify(preset.bounds);
  const center = JSON.stringify(preset.center);
  const pois = JSON.stringify(preset.pois);
  const tileData = JSON.stringify(tileDataMap);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
html,body{margin:0;padding:0;background:#06090f;height:100%;overflow:hidden;font-family:monospace}
#map{position:relative;width:100%;height:100%;background:radial-gradient(circle at top,#122033 0,#06090f 70%)}
#tiles,#poiLayer,#lineLayer,#nodeLayer,#tapLayer{position:absolute;inset:0}
.tile{position:absolute;object-fit:cover}
.poi,.node,.dist,.tap{position:absolute;transform:translate(-50%,-50%);pointer-events:none}
.poi{padding:3px 7px;border-radius:10px;border:1px solid rgba(91,163,255,.2);background:rgba(12,16,24,.88);color:#cbd5e1;font-size:10px;white-space:nowrap}
.node .dot{width:12px;height:12px;border-radius:999px;background:#5ba3ff;border:2px solid rgba(255,255,255,.25);box-shadow:0 0 10px rgba(91,163,255,.45);margin:0 auto 6px}
.node.own .dot{background:#34d399;box-shadow:0 0 12px rgba(52,211,153,.55)}
.node .label{padding:5px 9px;border-radius:12px;background:rgba(12,16,24,.9);border:1px solid rgba(91,163,255,.2);color:#e2e8f0;font-size:10px;white-space:nowrap;text-align:center}
.node.own .label{border-color:rgba(52,211,153,.28)}
.dist{padding:2px 6px;border-radius:999px;background:rgba(12,16,24,.92);border:1px solid rgba(91,163,255,.2);color:#5ba3ff;font-size:9px}
.tap{padding:5px 10px;border-radius:12px;background:rgba(12,16,24,.94);border:1px solid rgba(52,211,153,.28);color:#34d399;font-size:10px}
svg{width:100%;height:100%}
</style>
</head>
<body>
<div id="map">
  <div id="tiles"></div>
  <svg id="lineLayer"></svg>
  <div id="poiLayer"></div>
  <div id="nodeLayer"></div>
  <div id="tapLayer"></div>
</div>
<script>
const TILE_SIZE=256;
const ZOOM=${preset.zoom};
const GRID=${tileGrid};
const BOUNDS=${bounds};
const CENTER=${center};
const POIS=${pois};
const TILE_DATA=${tileData};
const tiles=document.getElementById('tiles');
const poiLayer=document.getElementById('poiLayer');
const nodeLayer=document.getElementById('nodeLayer');
const tapLayer=document.getElementById('tapLayer');
const lineLayer=document.getElementById('lineLayer');
const map=document.getElementById('map');
let nodes=[];
let userZoom=1;
let layout={left:0,top:0,scale:1,width:0,height:0};
const originX=GRID.minX*TILE_SIZE;
const originY=GRID.minY*TILE_SIZE;
const worldSize=TILE_SIZE*Math.pow(2,ZOOM);

function latLngToWorld(lat,lng){
  const x=((lng+180)/360)*worldSize;
  const sin=Math.sin(lat*Math.PI/180);
  const y=(0.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*worldSize;
  return {x,y};
}
function worldToLatLng(x,y){
  const lng=x/worldSize*360-180;
  const n=Math.PI-2*Math.PI*y/worldSize;
  const lat=180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n)));
  return {lat,lng};
}
function toScreen(lat,lng){
  const world=latLngToWorld(lat,lng);
  return {
    x:layout.left+(world.x-originX)*layout.scale,
    y:layout.top+(world.y-originY)*layout.scale
  };
}
function calcLayout(){
  const cols=GRID.maxX-GRID.minX+1;
  const rows=GRID.maxY-GRID.minY+1;
  const mapWidth=cols*TILE_SIZE;
  const mapHeight=rows*TILE_SIZE;
  const width=map.clientWidth;
  const height=map.clientHeight;
  const fitScale=Math.min((width-24)/mapWidth,(height-24)/mapHeight);
  const scale=Math.max(fitScale*0.7,Math.min(fitScale*2.6,fitScale*userZoom));
  layout={
    left:(width-mapWidth*scale)/2,
    top:(height-mapHeight*scale)/2,
    scale:scale,
    width:mapWidth*scale,
    height:mapHeight*scale
  };
}
function applyZoom(nextZoom){
  userZoom=Math.max(0.7,Math.min(2.6,nextZoom));
  render();
}
function renderTiles(){
  tiles.innerHTML='';
  let pending=0;
  let missing=0;
  const missingKeys=[];
  const total=(GRID.maxX-GRID.minX+1)*(GRID.maxY-GRID.minY+1);
  const report=()=>{
    pending-=1;
    if(pending===0){
      window.ReactNativeWebView.postMessage(
        JSON.stringify({type:'tile_status',missing:missing,total:total,keys:missingKeys.slice(0,12)})
      );
    }
  };
  for(let x=GRID.minX;x<=GRID.maxX;x++){
    for(let y=GRID.minY;y<=GRID.maxY;y++){
      const key=ZOOM+'/'+x+'/'+y;
      const fileUri='file:///android_asset/offline_tiles/'+key+'.png';
      const dataUri=TILE_DATA[key]||'';
      const primaryUri=dataUri||fileUri;
      const el=document.createElement('img');
      el.className='tile';
      el.style.left=(layout.left+(x-GRID.minX)*TILE_SIZE*layout.scale)+'px';
      el.style.top=(layout.top+(y-GRID.minY)*TILE_SIZE*layout.scale)+'px';
      el.style.width=(TILE_SIZE*layout.scale)+'px';
      el.style.height=(TILE_SIZE*layout.scale)+'px';
      let retriedFile=false;
      pending+=1;
      el.onerror=()=>{
        if(!retriedFile && primaryUri!==fileUri){
          retriedFile=true;
          el.src=fileUri;
          return;
        }
        missing+=1;
        missingKeys.push(key);
        el.style.background='rgba(12,16,24,.55)';
        report();
      };
      el.onload=()=>{report();};
      el.src=primaryUri;
      tiles.appendChild(el);
    }
  }
}
function renderPois(){
  poiLayer.innerHTML='';
  POIS.forEach((poi)=>{
    const pos=toScreen(poi.lat,poi.lng);
    const el=document.createElement('div');
    el.className='poi';
    el.style.left=pos.x+'px';
    el.style.top=pos.y+'px';
    el.textContent=(poi.icon?poi.icon+' ':'')+poi.name;
    poiLayer.appendChild(el);
  });
}
function meters(a,b,c,d){
  const R=6371000;
  const dLat=(c-a)*Math.PI/180;
  const dLng=(d-b)*Math.PI/180;
  const x=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
  const y=2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
  const m=R*y;
  return m<1000?Math.round(m)+' m':(m/1000).toFixed(2)+' km';
}
function renderNodes(){
  nodeLayer.innerHTML='';
  tapLayer.innerHTML='';
  lineLayer.innerHTML='';
  nodes.forEach((node)=>{
    const pos=toScreen(node.lat,node.lng);
    const el=document.createElement('div');
    el.className='node'+(node.isOwn?' own':'');
    el.style.left=pos.x+'px';
    el.style.top=pos.y+'px';
    el.innerHTML='<div class="dot"></div><div class="label">'+node.name+'<br/>'+node.lat.toFixed(6)+', '+node.lng.toFixed(6)+'</div>';
    nodeLayer.appendChild(el);
  });
  for(let i=0;i<nodes.length-1;i++){
    for(let j=i+1;j<nodes.length;j++){
      const a=toScreen(nodes[i].lat,nodes[i].lng);
      const b=toScreen(nodes[j].lat,nodes[j].lng);
      const line=document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1',a.x); line.setAttribute('y1',a.y);
      line.setAttribute('x2',b.x); line.setAttribute('y2',b.y);
      line.setAttribute('stroke','rgba(91,163,255,0.38)');
      line.setAttribute('stroke-width','2');
      line.setAttribute('stroke-dasharray','8 6');
      lineLayer.appendChild(line);
      const dist=document.createElement('div');
      dist.className='dist';
      dist.style.left=((a.x+b.x)/2)+'px';
      dist.style.top=((a.y+b.y)/2)+'px';
      dist.textContent=meters(nodes[i].lat,nodes[i].lng,nodes[j].lat,nodes[j].lng);
      nodeLayer.appendChild(dist);
    }
  }
}
function render(){
  calcLayout();
  renderTiles();
  renderPois();
  renderNodes();
}
window.updateNodes=function(nextNodes){nodes=nextNodes||[];renderNodes();};
window.zoomIn=function(){applyZoom(userZoom*1.18);};
window.zoomOut=function(){applyZoom(userZoom/1.18);};
window.resetZoom=function(){applyZoom(1);};
window.focusNode=function(uid){
  const entry=nodes.find((node)=>node.uid===uid);
  if(!entry){return;}
  tapLayer.innerHTML='';
  const pos=toScreen(entry.lat,entry.lng);
  const tap=document.createElement('div');
  tap.className='tap';
  tap.style.left=pos.x+'px';
  tap.style.top=(pos.y-64)+'px';
  tap.textContent='Focused: '+entry.name;
  tapLayer.appendChild(tap);
  setTimeout(()=>{if(tap.parentNode){tap.remove();}},2000);
};
map.addEventListener('click',(event)=>{
  const rect=map.getBoundingClientRect();
  const x=event.clientX-rect.left;
  const y=event.clientY-rect.top;
  const localX=(x-layout.left)/layout.scale;
  const localY=(y-layout.top)/layout.scale;
  const point=worldToLatLng(originX+localX,originY+localY);
  tapLayer.innerHTML='';
  const tap=document.createElement('div');
  tap.className='tap';
  tap.style.left=x+'px';
  tap.style.top=(y-26)+'px';
  tap.textContent=point.lat.toFixed(6)+', '+point.lng.toFixed(6);
  tapLayer.appendChild(tap);
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'tap',lat:point.lat,lng:point.lng}));
});
window.addEventListener('resize',render);
render();
window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
</script>
</body>
</html>`;
}

const mono = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: 10,
    backgroundColor: 'rgba(12,16,24,0.92)',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: { fontFamily: mono, fontSize: 13, fontWeight: '700', color: Colors.accent, letterSpacing: 2 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: 'rgba(255,255,255,0.05)',
    fontFamily: mono,
    fontSize: 9,
    color: Colors.textSecondary,
  },
  badgeLive: { color: Colors.green, borderColor: 'rgba(52,211,153,0.2)', backgroundColor: 'rgba(52,211,153,0.08)' },
  mapPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  mapPresetBtn: {
    width: '48%',
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(91,163,255,0.18)',
    backgroundColor: 'rgba(15,23,36,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapPresetBtnActive: {
    borderColor: 'rgba(91,163,255,0.34)',
    backgroundColor: 'rgba(91,163,255,0.12)',
  },
  mapPresetText: { fontFamily: mono, fontSize: 10, fontWeight: '700', color: Colors.textSecondary },
  mapPresetTextActive: { color: Colors.accent },
  subheader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  coordsText: { flex: 1, fontFamily: mono, fontSize: 10, color: Colors.textSecondary },
  mapControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  centerBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(91,163,255,0.22)', backgroundColor: 'rgba(91,163,255,0.08)' },
  centerBtnText: { fontFamily: mono, fontSize: 9, fontWeight: '700', color: Colors.accent },
  zoomBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(91,163,255,0.28)',
    backgroundColor: 'rgba(91,163,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnText: { fontFamily: mono, fontSize: 14, fontWeight: '700', color: Colors.accent, lineHeight: 16 },
  zoomResetBtn: {
    paddingHorizontal: 8,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(91,163,255,0.22)',
    backgroundColor: 'rgba(91,163,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomResetText: { fontFamily: mono, fontSize: 8, fontWeight: '700', color: Colors.accent, letterSpacing: 0.6 },
  map: { flex: 1 },
  tileWarning: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 80,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.28)',
    backgroundColor: 'rgba(60,45,12,0.88)',
  },
  tileWarningText: {
    fontFamily: mono,
    fontSize: 10,
    color: Colors.warning,
  },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg },
  loadingText: { marginTop: 12, fontFamily: mono, fontSize: 12, color: Colors.textSecondary },
  tapCard: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 166 : 146,
    left: 12,
    right: 12,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.28)',
    backgroundColor: 'rgba(12,16,24,0.94)',
  },
  tapTitle: { fontFamily: mono, fontSize: 10, fontWeight: '700', color: Colors.green, letterSpacing: 1 },
  tapValue: { marginTop: 6, fontFamily: mono, fontSize: 14, fontWeight: '700', color: Colors.text },
  tapDistance: { marginTop: 6, fontFamily: mono, fontSize: 11, color: Colors.accent },
  bottomStrip: { position: 'absolute', left: 0, right: 0, bottom: 12, maxHeight: 62 },
  bottomStripContent: { paddingHorizontal: 12, gap: 6 },
  nodeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: 'rgba(12,16,24,0.92)',
  },
  nodeChipOwn: { borderColor: 'rgba(52,211,153,0.28)' },
  nodeName: { fontFamily: mono, fontSize: 10, fontWeight: '700', color: Colors.text },
  nodeNameOwn: { color: Colors.green },
  nodeDistance: { marginTop: 2, fontFamily: mono, fontSize: 8, color: Colors.textSecondary },
});
