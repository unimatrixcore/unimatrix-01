#!/usr/bin/env python3
"""Bounded stall recovery for native Arr-owned torrents. No requests credentials in outputs."""
import os,sys,json,time,pathlib,fcntl,argparse
BASE=pathlib.Path('/srv/streaming/deployment/download-reliability')
ACTIVE={'downloading','stalledDL','metaDL','forcedDL','forcedMetaDL'}
NO_PEER_SECONDS=20*60
STALL_SECONDS=45*60
COOLDOWN=60*60
MAX_DAILY=3
MAX_WEEKLY=8

def file_bytes(t):
    if isinstance(t.get('completed'), (int, float)) and t['completed'] >= 0:
        return int(t['completed'])
    if isinstance(t.get('size'), (int, float)) and t['size'] > 0:
        return round(t['size'] * max(0, min(1, t.get('progress', 0))))
    return int(t.get('downloaded', 0))


def evaluate(t,obs,now,healthy=True):
    """Pure detector: timers start only after we observe a healthy sample."""
    if not healthy:return None,obs
    if t.get('state') not in ACTIVE or t.get('progress',0)>=1:
        return None,None
    done=file_bytes(t)
    if not obs or now-obs.get('seen',0)>300:
        return None,{'first':now,'lastProgress':now,'downloaded':done,'seen':now,'windowStart':now,'windowBytes':done}
    obs=dict(obs);obs['seen']=now
    obs.setdefault('windowStart', now);obs.setdefault('windowBytes', done)
    elapsed = now - obs['windowStart']
    if elapsed >= 3600:
        if 0 <= done - obs['windowBytes'] < 4096 * elapsed:
            return 'Less than 4 KiB/s of file progress for 1 hour', obs
        obs.update(windowStart=now, windowBytes=done)
    if done>obs['downloaded']:
        obs.update(lastProgress=now,downloaded=done);return None,obs
    waited=now-obs['lastProgress']
    if done==0 and not t.get('num_seeds',0) and not t.get('num_leechs',0) and waited>=NO_PEER_SECONDS:
        return 'No peers or download progress for 20 minutes',obs
    if t.get('state') in {'metaDL','forcedMetaDL'} and waited>=NO_PEER_SECONDS:
        return 'Metadata unavailable for 20 minutes',obs
    if waited>=STALL_SECONDS:return 'No download progress for 45 minutes',obs
    return None,obs

def permitted(history,key,now):
    h=history.get(key,[])
    return (not h or now-h[-1]>=COOLDOWN) and sum(now-x<86400 for x in h)<MAX_DAILY and sum(now-x<7*86400 for x in h)<MAX_WEEKLY

def atomic(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,indent=2));os.chmod(tmp,0o600);tmp.replace(path)


RECONCILE_RETRY_SECONDS = 6 * 3600
RECONCILE_MAX_PER_RUN = 1
VIDEO_SUFFIXES = {'.mkv', '.mp4', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg', '.webm', '.wmv', '.flv'}


def positive_id(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def media_path(value, media_root):
    if not isinstance(value, str) or not value or '\\' in value:
        return None
    source = pathlib.PurePosixPath(value)
    if not source.is_absolute() or '..' in source.parts:
        return None
    try:
        relative = source.relative_to('/data/media')
        target = (media_root / str(relative)).resolve()
        target.relative_to(media_root.resolve())
        return target
    except (ValueError, OSError, RuntimeError):
        return None


def imported_file_path(record, title_path, media_root):
    if not isinstance(record, dict) or not positive_id(record.get('id')):
        return None
    value = record.get('path')
    if not value:
        relative = record.get('relativePath')
        if not isinstance(relative, str) or not relative or pathlib.PurePosixPath(relative).is_absolute():
            return None
        value = str(pathlib.PurePosixPath(title_path) / relative)
    target = media_path(value, media_root)
    parent = media_path(title_path, media_root)
    if target is None or parent is None or target.suffix.lower() not in VIDEO_SUFFIXES:
        return None
    try:
        target.relative_to(parent)
    except ValueError:
        return None
    return target


def is_present(path):
    try:
        import stat
        return stat.S_ISREG(path.stat().st_mode)
    except FileNotFoundError:
        return False
    except OSError:
        return None


def reconcile_missing_media(objects, arr, state, now, dry_run=False,
                            media_root=pathlib.Path('/srv/streaming/data/media'),
                            present=is_present, persist=lambda: None):
    """Refresh missing imported files; unknown paths and filesystem failures fail closed."""
    result = {'planned': [], 'submitted': [], 'failed': []}
    try:
        if not media_root.is_dir():
            return result
    except OSError:
        return result
    history = state.get('reconciliation', {})
    attempts = 0
    for app in ('radarr', 'sonarr'):
        for obj in objects.get(app, {}).values():
            if attempts >= RECONCILE_MAX_PER_RUN:
                return result
            oid, title_path = obj.get('id'), obj.get('path')
            if not positive_id(oid) or media_path(title_path, media_root) is None:
                continue
            try:
                if app == 'radarr':
                    if obj.get('hasFile') is not True:
                        continue
                    record = obj.get('movieFile')
                    if not isinstance(record, dict) or not positive_id(record.get('id')):
                        if not positive_id(obj.get('movieFileId')):
                            continue
                        record = arr(app, '/moviefile/' + str(obj['movieFileId']))
                    records = [record]
                else:
                    count = (obj.get('statistics') or {}).get('episodeFileCount')
                    if not positive_id(count):
                        continue
                    records = arr(app, '/episodefile?seriesId=' + str(oid))
                    if not isinstance(records, list) or not records:
                        continue
                paths = [imported_file_path(record, title_path, media_root) for record in records]
                if not paths or any(path is None for path in paths):
                    continue
                existence = [present(path) for path in paths]
                if any(value is None for value in existence) or not any(value is False for value in existence):
                    continue
            except Exception:
                continue
            key = app + ':' + str(oid)
            previous = history.get(key, {})
            last_attempt = previous.get('lastAttempt')
            if isinstance(last_attempt, (int, float)) and now - last_attempt < RECONCILE_RETRY_SECONDS:
                continue
            result['planned'].append(key)
            attempts += 1
            if dry_run:
                continue
            state.setdefault('reconciliation', {})[key] = {'lastAttempt': now}
            persist()
            command = {'name': 'RefreshMovie', 'movieId': oid} if app == 'radarr' else {'name': 'RefreshSeries', 'seriesId': oid}
            try:
                arr(app, '/command', command)
                result['submitted'].append(key)
            except Exception:
                result['failed'].append(key)
    return result

def recovery_remaining(job, rows, get_episode):
    targets = job.get('episodeIds') or job.get('command', {}).get('episodeIds', [])
    covered = {r.get('episodeId') for r in rows
               if r.get('seriesId') == int(job['key'].split(':')[1])
               and (r.get('downloadId') or '').lower() != job['hash']}
    return [eid for eid in targets if eid not in covered and not get_episode(eid).get('hasFile')]


def search_missing_episodes(series, rows, commands, state, now, arr, persist=lambda: None, dry_run=False):
    """Bounded per-episode fallback for monitored, aired files with no active source."""
    queued = {q.get('episodeId') for q in rows}
    active = [c for c in commands if c.get('status') in ('queued', 'started') and 'Search' in c.get('name', '')]
    for obj in series.values():
        sid = obj.get('id')
        key = 'sonarr:' + str(sid)
        if not obj.get('monitored') or key in state.get('pending', {}):
            continue
        if any(c.get('body', {}).get('seriesId') == sid for c in active):
            continue
        eps = arr('sonarr', '/episode?seriesId=' + str(sid))
        active_ids = {eid for c in active for eid in c.get('body', {}).get('episodeIds', [])}
        candidates = []
        for e in eps:
            if not e.get('monitored') or e.get('hasFile') or e['id'] in queued or e['id'] in active_ids:
                continue
            try:
                from datetime import datetime
                aired = datetime.fromisoformat(e['airDateUtc'].replace('Z', '+00:00')).timestamp()
                searched = datetime.fromisoformat(e['lastSearchTime'].replace('Z', '+00:00')).timestamp() if e.get('lastSearchTime') else 0
            except (ValueError, KeyError, TypeError):
                continue
            attempted = state.get('episodeSearches', {}).get(str(e['id']), 0)
            if aired <= now and now - max(searched, attempted) >= RECONCILE_RETRY_SECONDS:
                candidates.append(e)
        ids = [e['id'] for e in sorted(candidates, key=lambda e: (e['seasonNumber'], e['episodeNumber']))[:12]]
        if not ids:
            continue
        if not dry_run:
            for eid in ids:
                state.setdefault('episodeSearches', {})[str(eid)] = now
            persist()
            arr('sonarr', '/command', {'name': 'EpisodeSearch', 'episodeIds': ids})
        return ids
    return []

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--dry-run',action='store_true');args=parser.parse_args()
    sys.path.insert(0,'/srv/streaming/deployment')
    from runtime import arr,qb,qblogin,ctl
    BASE.mkdir(mode=0o700,exist_ok=True)
    lock=open(BASE/'guard.lock','w')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:lock.close();return
    statepath=BASE/('dry-run-state.json' if args.dry_run else 'guard-state.json')
    state=json.loads(statepath.read_text()) if statepath.exists() else {'observations':{},'history':{},'pending':{},'events':[]}
    now=time.time()
    try:
        assert ctl('vpn/status').get('status')=='running','VPN unavailable'
        qblogin();assert qb('transfer/info').get('connection_status')=='connected','Peer network unavailable'
        torrents={t['hash'].lower():t for t in qb('torrents/info')}
        queues={};objects={}
        for name in ['radarr','sonarr']:
            assert not any('all indexers' in h.get('message','').lower() or 'no indexers available with automatic' in h.get('message','').lower() for h in arr(name,'/health')),'Indexer outage'
            assert any(i.get('enableAutomaticSearch') for i in arr(name,'/indexer')),'No automatic search indexes'
            queues[name]=arr(name,'/queue?pageSize=1000&includeUnknownMovieItems=false&includeUnknownSeriesItems=false&includeEpisode=true').get('records',[])
            objects[name]={x['id']:x for x in arr(name,'/movie' if name=='radarr' else '/series')}
    except Exception as e:
        # Never infer a dead torrent from outage, missing API data or old telemetry.
        state['observations']={};state['lastError']=type(e).__name__;state['lastChecked']=now
        atomic(statepath,state);print('Download guard deferred: service/network check failed');lock.close();return
    state.pop('lastError',None);state['lastChecked']=now
    def persist():
        state['events']=state['events'][-100:];atomic(statepath,state)
        if not args.dry_run:
            pub=pathlib.Path('/srv/streaming/config/request-telemetry/recovery.json')
            public={'generatedAt':now,'pending':{k:{f:v for f,v in j.items() if f in ['phase','reason','at','lastSearch','searchAttempts','seasonNumbers']} for k,j in state['pending'].items()},'events':[{f:v for f,v in e.items() if f!='hash'} for e in state['events'][-30:]]}
            tmp=pub.with_suffix('.tmp');tmp.write_text(json.dumps(public));os.chmod(tmp,0o644);tmp.replace(pub)
    def search(job):
        if args.dry_run:return
        if job['app'] == 'sonarr':
            job.setdefault('episodeIds', list(job['command'].get('episodeIds', [])))
            remaining = recovery_remaining(job, queues['sonarr'], lambda eid: arr('sonarr', '/episode/' + str(eid)))
            hasnew = bool(job['episodeIds']) and not remaining
        else:
            hasnew=any((r.get('downloadId') or '').lower()!=job['hash'] and r.get('movieId')==int(job['key'].split(':')[1]) for r in queues['radarr'])
        obj=objects[job['app']].get(int(job['key'].split(':')[1]),{})
        if hasnew or (job['app']=='radarr' and obj.get('hasFile')):
            state['events'].append({'at':now,'kind':'search-completed','key':job['key'],**({'seasonNumbers':job['seasonNumbers']} if 'seasonNumbers' in job else {})});state['pending'].pop(job['key'],None);persist();return
        if job.get('commandId'):
            cmd=arr(job['app'],'/command/'+str(job['commandId']))
            if cmd.get('status') in ['queued','started']:return
            if cmd.get('status')=='completed':
                # The episode-scoped check above must not be satisfied by another season's download.
                obj=objects[job['app']].get(int(job['key'].split(':')[1]),{})
                tvfinished=job['app']=='sonarr' and bool(job.get('episodeIds')) and not remaining
                if hasnew or (job['app']=='radarr' and obj.get('hasFile')) or tvfinished:
                    state['events'].append({'at':now,'kind':'search-completed','key':job['key'],**({'seasonNumbers':job['seasonNumbers']} if 'seasonNumbers' in job else {})});state['pending'].pop(job['key'],None);persist();return
                job.pop('commandId',None);job['searchDelay']=6*3600
                if job.get('searchAttempts',0)>=8:
                    job.update(phase='exhausted',exhaustedAt=now);persist();return
        if job.get('searchAttempts',0)>=8:
            job.update(phase='exhausted',exhaustedAt=now);persist();return
        if job.get('lastSearch') and now-job['lastSearch']<job.get('searchDelay',COOLDOWN):return
        job.update(lastSearch=now,searchAttempts=job.get('searchAttempts',0)+1);persist()
        if job['app'] == 'sonarr':job['command']['episodeIds'] = remaining
        cmd=arr(job['app'],'/command',job['command']);job['commandId']=cmd['id'];persist()
    EXHAUSTED_TTL = 7 * 86400
    for key, job in list(state['pending'].items()):
        if job.get('phase') == 'exhausted':
            obj = objects[job['app']].get(int(job['key'].split(':')[1]), {})
            hasnew = any((q.get('downloadId') or '').lower() in torrents for q in queues[job['app']] if (q.get('movieId') if job['app']=='radarr' else q.get('seriesId')) == int(job['key'].split(':')[1]))
            if hasnew or (job['app'] == 'radarr' and obj.get('hasFile')):
                state['events'].append({'at': now, 'kind': 'search-completed', 'key': key, **({'seasonNumbers': job['seasonNumbers']} if 'seasonNumbers' in job else {})})
                state['pending'].pop(key, None)
                persist()
                continue
            if now - job.get('exhaustedAt', job.get('at', 0)) >= EXHAUSTED_TTL:
                state['pending'].pop(key, None)
                state['events'].append({'at': now, 'kind': 'recovery-expired', 'key': key})
                persist()
    # Durable pending searches are retried after a transient API failure, without deleting again.
    for job in list(state['pending'].values()):
        if job.get('phase')=='removed':
            try:search(job)
            except Exception:pass
    live=set();actions=0
    for app,rows in queues.items():
        groups={}
        for q in rows:
            h=(q.get('downloadId') or '').lower()
            if h:groups.setdefault(h,[]).append(q)
        for h,items in groups.items():
            t=torrents.get(h)
            if not t:continue
            q=items[0];oid=q.get('movieId') if app=='radarr' else q.get('seriesId');obj=objects[app].get(oid)
            if not obj or not obj.get('monitored') or t.get('category')!=app:continue
            if app=='radarr' and obj.get('hasFile'):continue
            if app=='sonarr':
                eps=sorted({i['episodeId'] for i in items if i.get('episodeId')})
                if not eps:continue
                episodeObjects=[arr(app,'/episode/'+str(e)) for e in eps]
                episodeObjects=[e for e in episodeObjects if e.get('monitored',False)]
                eps=[e['id'] for e in episodeObjects]
                if not eps:continue
                seasonNumbers=sorted({e['seasonNumber'] for e in episodeObjects})
                command={'name':'EpisodeSearch','episodeIds':eps}
            else:command={'name':'MoviesSearch','movieIds':[oid]}
            key=app+':'+str(oid);live.add(h)
            reason,obs=evaluate(t,state['observations'].get(h),now)
            if obs:state['observations'][h]=obs
            else:state['observations'].pop(h,None)
            budget_key = key + (':' + ','.join(map(str, eps)) if app == 'sonarr' else '')
            if not reason or actions or key in state['pending'] or not permitted(state['history'],budget_key,now):continue
            if args.dry_run:
                print('Would replace stalled managed torrent:',app,oid,reason);continue
            # Race check: never cancel a torrent that started progressing since the sample.
            fresh=qb('torrents/info',{'hashes':h})
            if len(fresh)!=1 or fresh[0].get('state') not in ACTIVE or fresh[0].get('progress',0)>=1 or fresh[0].get('dlspeed',0)>4096 or file_bytes(fresh[0])>file_bytes(t)+65536:continue
            rowsnow=arr(app,'/queue?pageSize=1000').get('records',[])
            if not any(i.get('id')==q['id'] and (i.get('downloadId') or '').lower()==h for i in rowsnow):continue
            # If a previous call was interrupted after deletion, skipRedownload prevents duplicate native search.
            job={'app':app,'key':key,'hash':h,'queueId':q['id'],'reason':reason,'phase':'removing','command':command,'at':now,'budgetKey':budget_key}
            if app=='sonarr':job['seasonNumbers']=seasonNumbers
            state['pending'][key]=job;persist()
            try:
                arr(app,'/queue/'+str(q['id'])+'?removeFromClient=true&blocklist=true&skipRedownload=true',method='DELETE')
            except Exception:
                queueStillPresent=any(i.get('id')==q['id'] for i in arr(app,'/queue?pageSize=1000').get('records',[]))
                clientStillPresent=any(i.get('hash','').lower()==h for i in qb('torrents/info',{'hashes':h}))
                if queueStillPresent and clientStillPresent:
                    state['pending'].pop(key,None);persist();continue
            job['phase']='removed';state['history'].setdefault(job.get('budgetKey', key),[]).append(now)
            state['events'].append({'at':now,'kind':'replaced','key':key,'hash':h,'reason':reason,**({'seasonNumbers':job['seasonNumbers']} if 'seasonNumbers' in job else {})});persist();actions+=1
            print('Replacing stalled managed torrent:',app,oid,reason)
            try:search(job)
            except Exception:print('Replacement search deferred; will retry')
    try:
        fallback = search_missing_episodes(objects['sonarr'], queues['sonarr'], arr('sonarr', '/command'),
                                          state, now, arr, persist, args.dry_run)
        if fallback:print('Episode fallback:', 'planned' if args.dry_run else 'submitted', len(fallback), 'missing episodes')
    except Exception:
        print('Episode fallback deferred; service response unavailable')
    # Recover a crash between native deletion and the durable phase update safely.
    for key,job in list(state['pending'].items()):
        if job.get('phase')=='removing' and not any((q.get('downloadId') or '').lower()==job['hash'] for q in queues.get(job['app'],[])):
            job['phase']='removed';state['history'].setdefault(job.get('budgetKey', key),[]).append(now);persist()
            try:search(job)
            except Exception:pass
        elif job.get('phase')=='removing':
            state['pending'].pop(key,None)
    state['observations']={k:v for k,v in state['observations'].items() if k in live}
    state['history']={k:[v for v in vals if now-v<7*86400] for k,vals in state['history'].items()}
    reconciliation = reconcile_missing_media(objects, arr, state, now,
        dry_run=args.dry_run, persist=persist)
    if reconciliation['planned']:
        print('Media reconciliation:', 'would refresh' if args.dry_run else 'submitted',
              len(reconciliation['planned'] if args.dry_run else reconciliation['submitted']),
              'titles; failures', len(reconciliation['failed']))
    reconciled = bool(reconciliation['submitted'])
    if reconciled and not args.dry_run:
        try:
            import runtime
            seerr_fn = getattr(runtime, 'seerr', None)
            if seerr_fn:
                seerr_fn('/settings/jobs/availability-sync/run', {}, 'POST')
                print("Triggered Seerr availability-sync after disk reconciliation")
        except Exception as ex:
            print("Seerr availability-sync trigger failed:", ex)

    persist();print('Download guard checked',len(live),'managed torrents; replacements',actions);lock.close()
if __name__=='__main__':main()
