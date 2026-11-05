import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Location from 'expo-location';
import { palette } from '../../theme';
import { Button, Input, useOnline, type Colors } from '../ui/common';
import { X } from '../../icons';
import type { LocationInput } from '../services/transactionDetails';

/**
 * OpenStreetMap provider notes (also in docs/PHASE_FEATURES.md):
 *  - Tiles: tile.openstreetmap.org, subject to the OSM Tile Usage Policy (attribution shown, light use only; not for bulk/offline caching).
 *  - Search/reverse: Nominatim (nominatim.openstreetmap.org), max 1 request/second, an identifying User-Agent, no autocomplete.
 *    Searches here run only when the user submits, and are throttled to 1/s. For heavier use, self-host or use a commercial OSM provider.
 */
// react-native-webview's class typings predate React 19's JSX types
const MapView = WebView as any;

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const HEADERS = { 'User-Agent': 'Velnora/1.0 (personal finance app; contact via app store listing)', Accept: 'application/json' };
let lastCall = 0;
async function nominatim(path: string): Promise<unknown> {
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(`${NOMINATIM}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Place service error (${res.status})`);
  return res.json();
}

const MAP_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{height:100%;margin:0}</style></head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var map=L.map('m').setView([20.5937,78.9629],5), marker=null;
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
function put(lat,lng,zoom){ if(marker) marker.setLatLng([lat,lng]); else marker=L.marker([lat,lng]).addTo(map); if(zoom) map.setView([lat,lng],zoom); }
map.on('click',function(e){ put(e.latlng.lat,e.latlng.lng); window.ReactNativeWebView.postMessage(JSON.stringify({lat:e.latlng.lat,lng:e.latlng.lng})); });
</script></body></html>`;

type Place = { lat: number; lng: number; name: string | null; address: string | null };

export function LocationPicker({ visible, initial, colors, onCancel, onConfirm }: {
  visible: boolean; initial: LocationInput | null; colors: Colors; onCancel: () => void; onConfirm: (loc: LocationInput) => void;
}) {
  const web = useRef<{ injectJavaScript(js: string): void } | null>(null);
  const online = useOnline();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ display_name: string; lat: string; lon: string; name?: string }[]>([]);
  const [place, setPlace] = useState<Place | null>(initial ? { lat: initial.lat, lng: initial.lng, name: initial.name ?? null, address: initial.address ?? null } : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const show = (lat: number, lng: number, zoom = 16) => web.current?.injectJavaScript(`put(${lat},${lng},${zoom});true;`);
  const reverse = async (lat: number, lng: number) => {
    setPlace({ lat, lng, name: null, address: null });
    try {
      const r = (await nominatim(`/reverse?format=jsonv2&lat=${lat}&lon=${lng}`)) as { display_name?: string; name?: string };
      setPlace({ lat, lng, name: r.name || null, address: r.display_name ?? null });
    } catch { /* coordinates alone are still valid; never invent an address */ }
  };
  const onMessage = (e: WebViewMessageEvent) => { try { const m = JSON.parse(e.nativeEvent.data) as { lat: number; lng: number }; void reverse(m.lat, m.lng); } catch { /* ignore */ } };
  const search = async () => {
    if (!query.trim()) return;
    setBusy(true); setNote('');
    try {
      const r = (await nominatim(`/search?format=jsonv2&limit=5&q=${encodeURIComponent(query.trim())}`)) as typeof results;
      setResults(r); if (r.length === 0) setNote('No places found.');
    } catch (err) { setNote(err instanceof Error ? err.message : 'Search failed. Check your connection.'); }
    finally { setBusy(false); }
  };
  const useMyLocation = async () => {
    setNote('');
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') { setNote('Location permission was not granted. You can still search or tap the map.'); return; }
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      show(pos.coords.latitude, pos.coords.longitude); await reverse(pos.coords.latitude, pos.coords.longitude);
      setNote('Pin placed at your current position. Move it if the purchase was elsewhere.');
    } catch { setNote('Could not read your position. Search or tap the map instead.'); }
  };

  return <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>Transaction location</Text>
        <Pressable onPress={onCancel} hitSlop={12} accessibilityLabel="Close"><X color={colors.muted} /></Pressable>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <Input colors={colors} value={query} onChangeText={setQuery} placeholder="Search for a place" returnKeyType="search" onSubmitEditing={() => void search()} accessibilityLabel="Search place" />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><Button title="Search" onPress={() => void search()} busy={busy} disabled={!online} /></View>
          <View style={{ flex: 1 }}><Button title="Use my location" kind="ghost" onPress={() => void useMyLocation()} /></View>
        </View>
        {!online ? <Text style={{ color: palette.warning, marginTop: 6 }}>Offline: the map and place search need internet. Your transaction is unaffected.</Text> : null}
        {note ? <Text style={{ color: colors.muted, marginTop: 6 }}>{note}</Text> : null}
      </View>
      {results.length > 0 ? <ScrollView style={{ maxHeight: 150, marginTop: 8 }} keyboardShouldPersistTaps="handled">
        {results.map((r, i) => <Pressable key={`${r.lat},${r.lon},${i}`} style={{ paddingHorizontal: 16, paddingVertical: 10 }} onPress={() => { const lat = Number(r.lat); const lng = Number(r.lon); setPlace({ lat, lng, name: r.name || null, address: r.display_name }); show(lat, lng); setResults([]); }}>
          <Text numberOfLines={2} style={{ color: colors.text }}>{r.display_name}</Text></Pressable>)}
      </ScrollView> : null}
      <View style={{ flex: 1, marginTop: 8 }}>
        {online ? <MapView ref={web} originWhitelist={['*']} source={{ html: MAP_HTML, baseUrl: 'https://velnora.local' }} onMessage={onMessage} javaScriptEnabled
          onLoadEnd={() => { if (place) show(place.lat, place.lng); }} style={{ flex: 1 }} /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.muted }}>Map unavailable offline</Text></View>}
      </View>
      <View style={{ padding: 16 }}>
        <Text numberOfLines={3} style={{ color: place ? colors.text : colors.muted, marginBottom: 6 }}>{place ? (place.name || place.address || `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`) : 'Tap the map or search to choose a place.'}</Text>
        {place?.address && place.name ? <Text numberOfLines={2} style={{ color: colors.muted, fontSize: 12, marginBottom: 6 }}>{place.address}</Text> : null}
        <Button title="Confirm location" disabled={!place} onPress={() => place && onConfirm({ lat: place.lat, lng: place.lng, name: place.name, address: place.address, confirmed: true })} />
      </View>
    </SafeAreaView>
  </Modal>;
}
