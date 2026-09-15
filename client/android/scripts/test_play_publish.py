import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

HERE=Path(__file__).parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

publish=load('publish-play')
aab=load('verify-aab')

class PublishingTests(unittest.TestCase):
    def test_channels_cannot_cross_into_production(self):
        self.assertEqual(publish.release_plan('1.2.3-dev.gabc','dev')['track'],'internal')
        self.assertEqual(publish.release_plan('1.2.3','stable')['track'],'production')
        self.assertEqual(publish.release_plan('1.2.3-beta.1','beta','closed-testers')['track'],'closed-testers')
        for version,channel,track in [('1.2.3-dev.1','stable','internal'),('1.2.3','dev','internal'),('1.2.3-dev.1','dev','production'),('1.2.3-dev.1','dev','tv:production')]:
            with self.assertRaises(ValueError):publish.release_plan(version,channel,track)

    def test_digest_and_identity_are_checked_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle=Path(directory)/'app.aab';bundle.write_bytes(b'verified bundle')
            meta=Path(directory)/'app.json'
            data={'applicationId':publish.PACKAGE,'versionName':'1.2.3','versionCode':100,'aabSha256':hashlib.sha256(bundle.read_bytes()).hexdigest(),'targetSdk':36,'nativePageAlignment':16384}
            meta.write_text(json.dumps(data))
            self.assertEqual(publish.verify_artifact(bundle,meta,'1.2.3')['versionCode'],100)
            bundle.write_bytes(b'tampered')
            with self.assertRaises(ValueError):publish.verify_artifact(bundle,meta,'1.2.3')

    def test_native_alignment_rejects_4kb_load_segments(self):
        data=bytearray(120);data[:6]=b'\x7fELF\x02\x01'
        struct.pack_into('<Q',data,32,64);struct.pack_into('<HH',data,54,56,1)
        struct.pack_into('<I',data,64,1);struct.pack_into('<Q',data,112,16384)
        aab.elf_alignment(data)
        struct.pack_into('<Q',data,112,4096)
        with self.assertRaises(ValueError):aab.elf_alignment(data)

    def test_commit_is_last_and_failures_do_not_publish(self):
        class API:
            def __init__(self,fail=False):self.calls=[];self.fail=fail
            def request(self,method,path,data=None,bundle=None):
                self.calls.append((method,path,data))
                if path=='/edits':return {'id':'edit'}
                if method=='GET' and '/tracks/' in path:return {'releases':[]}
                if method=='GET' and path.endswith('/bundles'):return {'bundles':[]}
                if bundle:return {'versionCode':123,'sha256':'abc'}
                if path.endswith(':validate') and self.fail:raise RuntimeError('validation failed')
                return {}
        plan=publish.release_plan('1.2.3','stable')
        api=API();publish.publish(api,plan,Path('bundle'),{'versionCode':123,'aabSha256':'abc'},[])
        self.assertEqual(api.calls[-1][1],'/edits/edit:commit')
        self.assertEqual(next(data for method,path,data in api.calls if method=='PUT')['track'],'production')
        api=API(True)
        with self.assertRaises(RuntimeError):publish.publish(api,plan,Path('bundle'),{'versionCode':123,'aabSha256':'abc'},[])
        self.assertFalse(any(path.endswith(':commit') for _,path,_ in api.calls))
        self.assertEqual(api.calls[-1][:2],('DELETE','/edits/edit'))

    def test_old_build_does_not_replace_newer_track(self):
        class API:
            def request(self,method,path,data=None,bundle=None):
                if path=='/edits':return {'id':'edit'}
                if method=='DELETE':return {}
                if method=='GET':return {'releases':[{'versionCodes':['200']} ]}
                raise AssertionError('stale build must not upload or commit')
        result=publish.publish(API(),publish.release_plan('1.2.3','stable'),Path('bundle'),{'versionCode':100},[])
        self.assertTrue(result.startswith('skipped'))

if __name__=='__main__':unittest.main()
