"""Explicit emulator-only UI helpers; no Auth/database mocks or app data resets."""
import os,subprocess,xml.etree.ElementTree as E,re,time,pathlib,json
ADB=os.environ.get('ADB','adb');SERIAL=os.environ.get('PHC_EMULATOR_SERIAL','emulator-5554');PKG='com.sergioclaudecode.PHCmobile'
def adb(*args):return subprocess.check_output([ADB,'-s',SERIAL,*args],stderr=subprocess.STDOUT)
def tree():
 adb('shell','uiautomator','dump','/sdcard/phc-acceptance.xml');return E.fromstring(adb('exec-out','cat','/sdcard/phc-acceptance.xml'))
def tap(node):
 x1,y1,x2,y2=map(int,re.findall(r'\d+',node.get('bounds')));assert y2>y1 and x2>x1
 adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
def taptext(value):
 nodes=[n for n in tree().iter('node') if n.get('text')==value]
 if not nodes:raise RuntimeError('Not visible: '+value)
 tap(nodes[-1])
def inputs(values):
 fields=[n for n in tree().iter('node') if n.get('class')=='android.widget.EditText']
 assert len(fields)>=len(values)
 for i,value in enumerate(values):
  fields=[n for n in tree().iter('node') if n.get('class')=='android.widget.EditText'];tap(fields[i]);adb('shell','input','text',value.replace(' ','%s'));adb('shell','input','keyevent','111')
def waittext(text,timeout=35):
 end=time.time()+timeout
 while time.time()<end:
  if any(text in (n.get('text') or '') for n in tree().iter('node')):return
 raise RuntimeError('Text absent: '+text)
def shot(name):
 p=pathlib.Path('docs/audits/2026-11-12-product-acceptance')/(name+'.png');p.write_bytes(adb('exec-out','screencap','-p'))
if __name__=='__main__':
 assert SERIAL.startswith('emulator-');adb('shell','am','force-stop',PKG);adb('shell','am','start','-n',PKG+'/.MainActivity');waittext('Administrador');taptext('Administrador');inputs(['qa_admin@phc.local','PHC-Local-Admin-v2!']);start=time.monotonic();taptext('Iniciar sesión');waittext('Operadores');shot('android-admin-dashboard');print('Native administrator login UI confirmed; elapsed incl. UIAutomator polling:',round(time.monotonic()-start,2))
