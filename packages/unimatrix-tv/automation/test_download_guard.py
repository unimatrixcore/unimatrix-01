import copy
import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("download_guard", pathlib.Path(__file__).with_name("download_guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / "media"
        self.root.mkdir()
        self.state = {}
        self.calls = []
        self.episodes = [{"id": 41, "relativePath": "Season 01/Episode.mkv"}]
        self.movie = {"id": 1, "hasFile": True, "path": "/data/media/movies/Test", "movieFileId": 21,
                      "movieFile": {"id": 21, "relativePath": "Test.mkv"}}
        self.series = {"id": 2, "path": "/data/media/tv/Test", "statistics": {"episodeFileCount": 1}}

    def arr(self, app, url, data=None, method=None):
        self.calls.append((app, url, data, method))
        if url.startswith("/episodefile?"):
            return self.episodes
        if url == "/moviefile/21":
            return self.movie["movieFile"]
        if url == "/command":
            return {"id": 100}
        raise AssertionError((app, url))

    def objects(self, movie=None, series=None):
        return {"radarr": {1: movie} if movie else {}, "sonarr": {2: series} if series else {}}

    def run_guard(self, objects, **kwargs):
        return guard.reconcile_missing_media(objects, self.arr, self.state, 100_000,
                                             media_root=self.root, **kwargs)

    def commands(self):
        return [call for call in self.calls if call[1] == "/command"]

    def test_dry_run_plans_missing_import_without_commands_or_state_changes(self):
        original = copy.deepcopy(self.state)
        result = self.run_guard(self.objects(movie=self.movie), dry_run=True)
        self.assertEqual(result["planned"], ["radarr:1"])
        self.assertEqual(result["submitted"], [])
        self.assertEqual(self.commands(), [])
        self.assertEqual(self.state, original)

    def test_subtitle_does_not_mask_missing_imported_movie(self):
        folder = self.root / "movies/Test"
        folder.mkdir(parents=True)
        (folder / "Test.srt").write_text("subtitle")
        result = self.run_guard(self.objects(movie=self.movie))
        self.assertEqual(result["submitted"], ["radarr:1"])
        self.assertEqual(self.commands()[0][2], {"name": "RefreshMovie", "movieId": 1})

    def test_present_imported_movie_needs_no_refresh(self):
        path = self.root / "movies/Test/Test.mkv"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"video")
        self.assertEqual(self.run_guard(self.objects(movie=self.movie))["planned"], [])
        self.assertEqual(self.commands(), [])

    def test_import_record_can_be_loaded_from_native_movie_file_id(self):
        movie = {key: value for key, value in self.movie.items() if key != "movieFile"}
        result = self.run_guard(self.objects(movie=movie))
        self.assertEqual(result["submitted"], ["radarr:1"])
        self.assertEqual(self.calls[0][1], "/moviefile/21")

    def test_movie_without_imported_file_evidence_is_ignored(self):
        for movie in [{**self.movie, "hasFile": False},
                      {"id": 1, "path": self.movie["path"], "hasFile": True}]:
            self.assertEqual(self.run_guard(self.objects(movie=movie))["planned"], [])
        self.assertEqual(self.calls, [])

    def test_future_series_without_imports_causes_no_lookup_or_refresh(self):
        for count in [0, None, -1, "1", True]:
            series = {**self.series, "statistics": {"episodeFileCount": count}}
            self.assertEqual(self.run_guard(self.objects(series=series))["planned"], [])
        self.assertEqual(self.calls, [])

    def test_empty_episode_files_do_not_treat_stale_statistics_as_an_import(self):
        self.episodes = []
        self.assertEqual(self.run_guard(self.objects(series=self.series))["planned"], [])
        self.assertEqual(self.commands(), [])

    def test_missing_imported_episode_refreshes_even_if_series_directory_exists(self):
        (self.root / "tv/Test").mkdir(parents=True)
        result = self.run_guard(self.objects(series=self.series))
        self.assertEqual(result["submitted"], ["sonarr:2"])
        self.assertEqual(self.commands()[0][2], {"name": "RefreshSeries", "seriesId": 2})

    def test_present_series_files_do_not_refresh(self):
        path = self.root / "tv/Test/Season 01/Episode.mkv"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"video")
        self.assertEqual(self.run_guard(self.objects(series=self.series))["planned"], [])
        self.assertEqual(self.commands(), [])

    def test_retry_cooldown_prevents_ninety_second_refresh_storms(self):
        objects = self.objects(movie=self.movie)
        self.run_guard(objects)
        result = guard.reconcile_missing_media(objects, self.arr, self.state, 100_090, media_root=self.root)
        self.assertEqual(result["planned"], [])
        self.assertEqual(len(self.commands()), 1)
        guard.reconcile_missing_media(objects, self.arr, self.state, 100_000 + guard.RECONCILE_RETRY_SECONDS,
                                      media_root=self.root)
        self.assertEqual(len(self.commands()), 2)

    def test_reconciliation_is_bounded_across_managers(self):
        self.run_guard(self.objects(movie=self.movie, series=self.series))
        self.assertEqual(len(self.commands()), 1)
        result = guard.reconcile_missing_media(self.objects(movie=self.movie, series=self.series), self.arr,
                                               self.state, 100_090, media_root=self.root)
        self.assertEqual(result["submitted"], ["sonarr:2"])

    def test_intent_persists_before_command_and_failed_commands_also_have_cooldown(self):
        saved = []
        def failing(app, url, data=None, method=None):
            if url == "/command":
                self.assertTrue(saved)
                self.assertEqual(saved[-1]["reconciliation"]["radarr:1"]["lastAttempt"], 100_000)
                raise OSError("offline")
            return self.arr(app, url, data, method)
        result = guard.reconcile_missing_media(self.objects(movie=self.movie), failing, self.state, 100_000,
                                               media_root=self.root, persist=lambda: saved.append(copy.deepcopy(self.state)))
        self.assertEqual(result["failed"], ["radarr:1"])
        self.assertEqual(self.run_guard(self.objects(movie=self.movie))["planned"], [])

    def test_unsafe_title_and_imported_paths_fail_closed(self):
        paths = ["/etc", "/data/movies/Test", "/data/media/../private", "/data/media2/Test", "relative", "/data/media/tv\\Test"]
        for path in paths:
            with self.subTest(path=path):
                movie = {**self.movie, "path": path}
                self.assertEqual(self.run_guard(self.objects(movie=movie))["planned"], [])
        for relative in ["../../outside.mkv", "/etc/outside.mkv", "Test.srt"]:
            movie = {**self.movie, "movieFile": {"id": 21, "relativePath": relative}}
            self.assertEqual(self.run_guard(self.objects(movie=movie))["planned"], [])
        movie = {**self.movie, "movieFile": {"id": 21, "path": "/data/media/other/Test.mkv"}}
        self.assertEqual(self.run_guard(self.objects(movie=movie))["planned"], [])
        self.assertEqual(self.commands(), [])

    def test_symlink_escape_is_not_interpreted_as_deleted_media(self):
        (self.root / "movies").mkdir()
        (self.root / "movies/Test").symlink_to(pathlib.Path(self.temp.name) / "outside")
        self.assertEqual(self.run_guard(self.objects(movie=self.movie))["planned"], [])
        self.assertEqual(self.commands(), [])

    def test_unknown_filesystem_or_missing_media_root_cannot_trigger_refresh(self):
        self.assertEqual(self.run_guard(self.objects(movie=self.movie), present=lambda _: None)["planned"], [])
        self.root.rmdir()
        self.assertEqual(self.run_guard(self.objects(movie=self.movie))["planned"], [])
        self.assertEqual(self.commands(), [])

    def test_main_dry_run_has_zero_arr_mutation_commands(self):
        import sys
        runtime = types.ModuleType("runtime")
        def arr(app, url, data=None, method=None):
            if data is not None or method not in (None, "GET"):
                self.fail("dry-run made a mutation command")
            if url == "/health": return []
            if url == "/indexer": return [{"enableAutomaticSearch": True}]
            if url.startswith("/queue"): return {"records": []}
            if url == "/movie": return [self.movie]
            if url == "/series": return [self.series]
            return self.arr(app, url, data, method)
        runtime.arr = arr
        runtime.qb = lambda endpoint, *args: {"connection_status": "connected"} if endpoint == "transfer/info" else []
        runtime.qblogin = lambda: None
        runtime.ctl = lambda _: {"status": "running"}
        runtime.seerr = lambda *args: self.fail("dry-run triggered Seerr")
        with patch.dict(sys.modules, {"runtime": runtime}), patch.object(sys, "argv", ["download_guard.py", "--dry-run"]), patch.object(guard, "BASE", pathlib.Path(self.temp.name) / "guard"):
            guard.main()


class FileProgressTests(unittest.TestCase):
    def test_protocol_bytes_do_not_mask_stalled_file_progress(self):
        t = {'state':'stalledDL','size':1000000,'progress':0.8,'completed':800000,'downloaded':900000,'num_seeds':1}
        _, obs = guard.evaluate(t, None, 0)
        for now in range(90, 2791, 90):
            reason, obs = guard.evaluate({**t,'downloaded':900000+now*100}, obs, now)
        self.assertEqual(reason, 'No download progress for 45 minutes')

    def test_hour_of_trickle_is_bounded_even_when_pieces_keep_arriving(self):
        t = {'state':'downloading','size':100000000,'progress':0.2,'completed':20000000,'dlspeed':1000}
        _, obs = guard.evaluate(t, None, 0)
        for now in range(90, 3601, 90):
            reason, obs = guard.evaluate({**t,'completed':20000000+now*1000}, obs, now)
        self.assertEqual(reason, 'Less than 4 KiB/s of file progress for 1 hour')

    def test_healthy_file_progress_does_not_trigger_replacement(self):
        t = {'state':'downloading','size':1000000000,'progress':0.1,'completed':100000000}
        _, obs = guard.evaluate(t, None, 0)
        for now in range(90, 3601, 90):
            reason, obs = guard.evaluate({**t,'completed':100000000+now*10000}, obs, now)
            self.assertIsNone(reason)

class EpisodeRecoveryTests(unittest.TestCase):
    def test_another_season_cannot_complete_recovery(self):
        job = {'key': 'sonarr:2', 'hash': 'old', 'command': {'episodeIds': [11, 12]}}
        rows = [{'seriesId': 2, 'episodeId': 99, 'downloadId': 'different'}]
        self.assertEqual(guard.recovery_remaining(job, rows, lambda _: {'hasFile': False}), [11, 12])
        rows.append({'seriesId': 2, 'episodeId': 11, 'downloadId': 'new'})
        self.assertEqual(guard.recovery_remaining(job, rows, lambda _: {'hasFile': False}), [12])
        self.assertEqual(guard.recovery_remaining(job, rows, lambda _: {'hasFile': True}), [])

    def test_episode_fallback_skips_queued_imported_future_and_recent(self):
        now = 1792051200
        episodes = [dict(id=n, seasonNumber=1, episodeNumber=n, monitored=True,
                         hasFile=n==1, airDateUtc='2030-01-01T00:00:00Z' if n==4 else '2020-01-01T00:00:00Z') for n in range(1,7)]
        calls=[]
        def arr(app, url, data=None):
            if url.startswith('/episode?'):return episodes
            calls.append(data);return {'id': 1}
        state={'episodeSearches': {'5': now-100}}
        ids=guard.search_missing_episodes({2:{'id':2,'monitored':True}},
            [{'episodeId':2}], [{'name':'EpisodeSearch','status':'started','body':{'episodeIds':[3]}}], state, now, arr)
        self.assertEqual(ids,[6]);self.assertEqual(calls,[{'name':'EpisodeSearch','episodeIds':[6]}])
        self.assertEqual(guard.search_missing_episodes({2:{'id':2,'monitored':True}},
            [{'episodeId':2}], [{'name':'EpisodeSearch','status':'started','body':{'episodeIds':[3]}}], state, now+90, arr),[])

    def test_episode_fallback_dry_run_does_not_write_or_submit(self):
        state={}
        def arr(app,url,data=None):
            self.assertIsNone(data)
            return [{'id':1,'seasonNumber':1,'episodeNumber':1,'monitored':True,'hasFile':False,'airDateUtc':'2020-01-01T00:00:00Z'}]
        ids=guard.search_missing_episodes({2:{'id':2,'monitored':True}}, [], [], state, 1792051200, arr, dry_run=True)
        self.assertEqual(ids,[1]);self.assertEqual(state,{})

if __name__ == "__main__":
    unittest.main()
