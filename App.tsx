import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Keyboard, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import { fetch as nativeFetch } from 'expo/fetch';
import { downloadMissingResources } from './src/resources';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import injection from './src/recorder-source.json';
import { ingest, makeArchive, nativeEvent, newSession, normalizeUrl, Session, summarize } from './src/session';

export default function App() {
  const [address, setAddress] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const browser = useRef<WebView>(null);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [allLinks, setAllLinks] = useState(false);
  const [refetch, setRefetch] = useState(true);
  const [tab, setTab] = useState<'browser' | 'links' | 'events'>('browser');
  const [, refresh] = useState(0);
  const [savedUri, setSavedUri] = useState('');
  const pending = useRef<{ id: string; done: () => void } | null>(null);
  const summary = session ? summarize(session) : null;
  const visibleLinks = summary?.links.filter(link => allLinks || !['technical','resource'].includes(link.category));
  const linkLabels = { 'app-candidate':'Кандидат приложения', web:'Веб-ссылка · App Link не проверен', resource:'Ресурс', technical:'Служебный адрес', template:'Шаблон · параметры не вычислены' };
  useEffect(() => {
    const interval = setInterval(() => refresh(n => n + 1), 700);
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active' && current.current && !current.current.endedAt) nativeEvent(current.current, 'gap', { reason: 'app-backgrounded', state });
    });
    return () => { clearInterval(interval); listener.remove(); };
  }, []);
  function start() {
    try {
      const next = newSession(normalizeUrl(address));
      current.current = next; setSession(next); setActive(true); setSavedUri(''); setTab('browser'); Keyboard.dismiss();
    } catch (error) { Alert.alert('Адрес сайта', String(error)); }
  }
  async function exportSession() {
    if (!current.current || busy) return;
    setBusy(true); setProgress('Завершаем запись…');
    const target = current.current;
    try {
      if (active) {
        const requestId = 'finish-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => {
            nativeEvent(target, 'gap', { reason: 'snapshot-timeout-or-navigation' }); pending.current = null; resolve();
          }, 6000);
          pending.current = { id:requestId, done:() => { clearTimeout(timeout); pending.current = null; resolve(); } };
          browser.current?.injectJavaScript(`(function(){var id=${JSON.stringify(requestId)};function reply(kind,data){window.ReactNativeWebView.postMessage(JSON.stringify({protocol:'webtrace/1',id:id+kind,at:Date.now(),page:location.href,kind:kind,data:data}));}if(window.__webtrace && window.__webtrace.finish){window.__webtrace.finish(id).catch(function(e){reply('gap',{reason:'finish-error: '+String(e)});reply('snapshot-complete',{requestId:id});});}else{reply('gap',{reason:'recorder-unavailable-at-export'});reply('snapshot-complete',{requestId:id});}})(); true;`);
        });
        target.endedAt = new Date().toISOString();
        browser.current?.injectJavaScript('window.__webtrace && window.__webtrace.stop(); true;');
        setActive(false);
      }
      if (active && refetch) await downloadMissingResources(target, nativeFetch as typeof fetch, (done,total) => setProgress(`Файлы: ${done} / ${total}`));
      setProgress('Упаковываем ZIP…');
      const file = new File(Paths.document, target.id + '.zip');
      file.write(makeArchive(target)); setSavedUri(file.uri);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/zip', UTI: 'public.zip-archive', dialogTitle: 'Сохранить сессию WebTrace' });
      else Alert.alert('Архив сохранён', file.uri);
    } catch (error) { Alert.alert('Не удалось сохранить', String(error)); }
    finally { setBusy(false); setProgress(''); refresh(n => n + 1); }
  }
  function navigation(url: string) {
    const allowed = /^https?:/.test(url) || url === 'about:blank';
    if (current.current && !current.current.endedAt) {
      nativeEvent(current.current, 'link', { url, source: 'native-navigation', attempted: true, classification: /^https?:/.test(url) ? 'web-link-unverified' : 'custom-scheme' });
      if (!allowed) nativeEvent(current.current, 'navigation-blocked', { url, reason: 'external-scheme-recorded' });
    }
    return allowed;
  }
  return <SafeAreaProvider><SafeAreaView style={s.root}>
    <StatusBar style="light" />
    <View style={s.header}><View><Text style={s.brand}>WEBTRACE<Text style={{ color: '#7fffc7' }}> ●</Text></Text><Text style={s.caption}>Браузер с памятью</Text></View><Text style={s.badge}>{busy ? 'СОХРАНЕНИЕ' : active ? '● ЗАПИСЬ' : 'ЛОКАЛЬНО'}</Text></View>
    {!active && <View style={s.addressRow}>
      <TextInput accessibilityLabel="Ссылка на сайт" style={s.input} value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="Вставь ссылку на сайт" placeholderTextColor="#7d869b" onSubmitEditing={() => { if (!busy) start(); }} editable={!busy} />
      <Pressable accessibilityRole="button" disabled={busy} style={s.go} onPress={start}><Text style={s.goText}>Открыть</Text></Pressable>
    </View>}
    {session ? <>
      <Text numberOfLines={1} style={s.url}>{session.url}</Text>
      <View style={s.stats}>{[[summary?.actions, 'действия'], [summary?.requests, 'запросы'], [summary?.artifacts, 'файлы'], [summary?.links.length, 'ссылки']].map(([value, label]) => <View key={String(label)}><Text style={s.statValue}>{value}</Text><Text style={s.caption}>{label}</Text></View>)}</View>
      <View style={s.tabs}>{([['browser', 'Сайт'], ['links', 'Диплинки'], ['events', 'События']] as const).map(([key, title]) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === key }} key={key} onPress={() => setTab(key)} style={[s.tab, tab === key && s.selected]}><Text style={s.text}>{title}</Text></Pressable>)}</View>
      <View style={{ flex: 1 }}>
        {active ? <View pointerEvents={tab === 'browser' && !busy ? 'auto' : 'none'} style={[s.browser, tab !== 'browser' && { opacity: 0 }]}>
          <WebView key={session.id} ref={browser} source={{ uri: session.url }} style={{ flex: 1 }} originWhitelist={['*']} javaScriptEnabled
            injectedJavaScriptBeforeContentLoaded={injection} injectedJavaScript={injection}
            onShouldStartLoadWithRequest={request => navigation(request.url)}
            onNavigationStateChange={state => { if (!session.endedAt) nativeEvent(session, 'navigation', { url: state.url, loading: state.loading, title: state.title, source: 'webview-state' }); }}
            onOpenWindow={event => {
              const url = event.nativeEvent.targetUrl;
              if (navigation(url)) { nativeEvent(session, 'gap', { reason: 'popup-routed-to-main-frame', url }); browser.current?.injectJavaScript(`location.href=${JSON.stringify(url)}; true;`); }
            }}
            onMessage={event => {
              if (!current.current || current.current.endedAt) return;
              if (ingest(current.current, event.nativeEvent.data)) {
                const last = current.current.events.at(-1);
                if (last?.kind === 'snapshot-complete' && last.data.requestId === pending.current?.id) pending.current?.done();
              }
            }}
            onError={event => nativeEvent(session, 'gap', { reason: 'webview-load-error', message: event.nativeEvent.description })}
            onHttpError={event => nativeEvent(session, 'http-error', { status: event.nativeEvent.statusCode, url: event.nativeEvent.url })}
            onContentProcessDidTerminate={() => nativeEvent(session, 'gap', { reason: 'webview-process-terminated' })}
            onRenderProcessGone={() => nativeEvent(session, 'gap', { reason: 'webview-process-gone' })}
            startInLoadingState allowsBackForwardNavigationGestures allowFileAccess={false} mixedContentMode="never" />
        </View> : tab === 'browser' && <View style={s.empty}><Text style={s.title}>Сессия завершена</Text><Text style={s.description}>{savedUri ? 'ZIP сохранён на устройстве. Его можно передать в чат для анализа.' : 'События готовы к экспорту.'}</Text></View>}
        {tab === 'links' && <FlatList style={s.list} data={visibleLinks} keyExtractor={item => item.url} ListHeaderComponent={<View><Text style={s.hint}>«Наблюдался переход» означает попытку. Успешный запуск приложения не подтверждён.</Text><Pressable accessibilityRole="button" onPress={() => setAllLinks(!allLinks)} style={s.card}><Text style={s.link}>{allLinks ? 'Скрыть служебные ссылки и ресурсы' : 'Показать также служебные ссылки и ресурсы'}</Text></Pressable></View>} renderItem={({ item }) => <View style={s.card}><Text selectable style={s.link}>{item.url}</Text><Text style={s.caption}>{linkLabels[item.category]} · {item.attempted ? 'наблюдался переход' : 'найдено в данных'}</Text></View>} />}
        {tab === 'events' && <FlatList style={s.list} data={session.events.slice(-200).reverse()} keyExtractor={(_, index) => String(index)} ListHeaderComponent={<Text style={s.hint}>Последние 200 событий. Пробелов и пропусков: {summary?.gaps}. Неполных файлов: {summary?.incompleteFiles}. Все принятые события попадут в ZIP.</Text>} renderItem={({ item }) => <View style={s.card}><Text style={s.text}>{item.kind} <Text style={s.caption}>{new Date(item.at).toLocaleTimeString()}</Text></Text><Text numberOfLines={2} style={s.caption}>{String(item.data.url || item.data.reason || item.data.action || item.data.api || item.id)}</Text></View>} />}
      </View>
      <View style={s.footer}>
        {active && <View style={s.option}><View style={{ flex: 1 }}><Text style={s.text}>Догрузить ресурсы сайта</Text><Text style={s.caption}>Повторные GET · доступ ограничен CORS</Text></View><Switch value={refetch} onValueChange={setRefetch} disabled={busy} trackColor={{ true: '#317c68' }} /></View>}
        <Pressable accessibilityRole="button" style={[s.export, busy && { opacity: 0.6 }]} disabled={busy} onPress={exportSession}>{busy ? <View style={{flexDirection:'row', gap:10}}><ActivityIndicator color="#081513" /><Text style={s.goText}>{progress}</Text></View> : <Text style={s.goText}>{active ? 'Завершить и сохранить ZIP' : 'Поделиться ZIP'}</Text>}</Pressable>
      </View>
    </> : <View style={s.empty}>
      <Text style={s.eyebrow}>ССЫЛКА → ДЕЙСТВИЯ → АРХИВ</Text><Text style={s.title}>Посмотри, что{'\n'}происходит внутри.</Text>
      <Text style={s.description}>Открой сайт и пройди нужный сценарий. Соберём доступные скрипты, запросы, действия, таймеры и диплинки — в том числе попытку мгновенного перехода.</Text>
      <View style={s.card}><Text style={s.text}>Всё остаётся на устройстве</Text><Text style={s.hint}>Архив может содержать личные данные из страниц и ответов. Ты выбираешь, кому его передать. Полное покрытие сайта не гарантируется. Перед закрытием приложения сохрани ZIP.</Text></View>
    </View>}
  </SafeAreaView></SafeAreaProvider>;
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c1019' }, header: { padding: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, brand: { color: '#f4f6fc', fontSize: 22, fontWeight: '800', letterSpacing: 2 }, caption: { color: '#95a0b7', fontSize: 11, marginTop: 4 }, badge: { color: '#7fffc7', fontSize: 10, letterSpacing: 1 },
  addressRow: { flexDirection: 'row', marginHorizontal: 16, gap: 8, marginBottom: 12 }, input: { flex: 1, borderRadius: 12, backgroundColor: '#1a2130', color: 'white', padding: 14, fontSize: 14 }, go: { backgroundColor: '#7fffc7', paddingHorizontal: 16, justifyContent: 'center', borderRadius: 12 }, goText: { color: '#081513', fontWeight: '700', fontSize: 14 }, url: { color: '#95a0b7', marginHorizontal: 20, fontSize: 11 }, stats: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 14 }, statValue: { color: 'white', fontSize: 22, fontWeight: '600' },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, gap: 6, paddingBottom: 10 }, tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 9 }, selected: { backgroundColor: '#263348' }, text: { color: '#edf2fa', fontSize: 13 }, browser: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'white' }, list: { flex: 1, backgroundColor: '#0c1019', paddingHorizontal: 16 }, card: { padding: 15, backgroundColor: '#171f2d', borderRadius: 12, marginBottom: 8 }, link: { color: '#7fffc7', fontSize: 13 }, hint: { color: '#95a0b7', fontSize: 12, lineHeight: 18, marginVertical: 10 },
  empty: { flex: 1, padding: 24, justifyContent: 'center', gap: 20 }, eyebrow: { color: '#7fffc7', fontSize: 10, letterSpacing: 2 }, title: { color: '#f4f6fc', fontSize: 32, fontWeight: '700', lineHeight: 39 }, description: { color: '#a3afc5', fontSize: 15, lineHeight: 24 }, footer: { padding: 16, borderTopWidth: 1, borderTopColor: '#253044' }, option: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 }, export: { borderRadius: 12, backgroundColor: '#7fffc7', alignItems: 'center', padding: 16 },
});
