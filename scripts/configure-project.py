#!/usr/bin/env python3
"""Replace the portfolio host marker with a reviewer-owned Supabase project ref."""
import argparse,pathlib,re
p=argparse.ArgumentParser();p.add_argument('project_ref');a=p.parse_args()
if not re.fullmatch('[a-z]{20}',a.project_ref):p.error('Expected a 20-letter Supabase project reference')
root=pathlib.Path(__file__).resolve().parent.parent
paths=['PHC_Mobile/phc-native/src/api/config.ts','PHC_Mobile/phc-native/scripts/validate-android-release.js','PHC_Web_Admin/src/lib/supabase.ts','PHC_Web_Admin/vercel.json']
for relative in paths:
 path=root/relative;s=path.read_text();path.write_text(s.replace('portfolio-project',a.project_ref))
print('Configured project host. Set public keys in ignored client env files; server secrets stay server-side.')
