import importlib.util,pathlib,json,time
spec=importlib.util.spec_from_file_location('ui',str(pathlib.Path(__file__).with_name('android-ui.py')));u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
ev=pathlib.Path('docs/audits/2026-11-12-product-acceptance');data=json.loads(pathlib.Path('.local/full-acceptance-20261112/created-operator.json').read_text());result={'id':'ANDROID-UI-CREATED-OPERATOR-LOGIN','real_backend':True}
try:
 texts=[n.get('text') for n in u.tree().iter('node') if n.get('text')]
 if 'Panel de Operador' in texts:
  u.taptext('Cambiar operador');u.taptext('Cambiar operador')
 u.waittext('Seleccioná tu acceso');u.taptext('Operador');u.inputs([data['username'],data['password']]);u.adb('shell','input','keyevent','4');start=time.monotonic();u.taptext('Iniciar sesión');u.waittext('Panel de Operador');result.update(status='PASS',elapsed_seconds_including_poll=round(time.monotonic()-start,2));u.shot('android-ui-created-operator');
 texts=[n.get('text') for n in u.tree().iter('node') if n.get('text')];assert data['username'] in texts,'Wrong operator identity';result['identity_verified']=True
except Exception as e:result.update(status='FAIL',error=type(e).__name__+': '+str(e));u.shot('android-created-operator-failure')
ev.joinpath('android-created-operator.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
