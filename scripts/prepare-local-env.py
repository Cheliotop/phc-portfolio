#!/usr/bin/env python3
"""Create ignored client configuration from the running LOCAL Supabase stack."""
import pathlib,subprocess,os
root=pathlib.Path(__file__).resolve().parent.parent
key=subprocess.check_output(['node',str(root/'supabase/seed/mint-local-jwt.js'),'anon','--quiet'],text=True).strip()
if key.count('.')!=2:raise SystemExit('Expected local anonymous JWT')
files={root/'PHC_Mobile/phc-native/.env.local':f'EXPO_PUBLIC_PHC_LOCAL_QA=true\nEXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:54321\nEXPO_PUBLIC_SUPABASE_ANON_KEY={key}\n',root/'PHC_Web_Admin/.env.local':f'VITE_PHC_LOCAL_QA=true\nVITE_SUPABASE_URL=http://127.0.0.1:54321\nVITE_SUPABASE_PUBLISHABLE_KEY={key}\n'}
for path,data in files.items():
 if path.exists():raise SystemExit(f'Refusing to replace existing {path.relative_to(root)}')
for path,data in files.items():
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as out:out.write(data)
print('Local client configuration created. Keys were not printed. Restart dev servers.')
