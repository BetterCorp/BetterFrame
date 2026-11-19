#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: bash integrations/simplevms/build.sh /path/to/extended/simple-vms /path/to/new-output-directory' >&2
  exit 2
fi
task_source=$(realpath -- "$1")
task_output=$(realpath -m -- "$2")
task_integration=$(cd -- "$(dirname -- "$0")" && pwd)
test -f "$task_source/src/Server.Api/Server.Api.csproj"
mkdir -- "$task_output"
task_work=$(mktemp -d -t bf-svms-build.XXXXXXXX)
trap 'rm -rf -- "$task_work"' EXIT
python3 - "$task_source" "$task_work/host" <<'PY'
import shutil,sys
shutil.copytree(sys.argv[1],sys.argv[2],ignore=shutil.ignore_patterns('.git','bin','obj','node_modules','debug','data','out','runtime','runtime-test','artifacts','.env','.env.*'))
PY
task_patch="$task_integration/host-pairing/browser-pairing.patch"
if git -C "$task_work/host" apply --check "$task_patch"; then
  git -C "$task_work/host" apply "$task_patch"
elif ! git -C "$task_work/host" apply --reverse --check "$task_patch"; then
  echo 'The pairing patch does not match this native host. Review the host changes before building.' >&2
  exit 1
fi
dotnet publish "$task_integration/BetterFrame/BetterFrame.csproj" -p:SimpleVmsSource="$task_work/host" -c Release -o "$task_output/plugin" --nologo
dotnet publish "$task_work/host/src/Server.Api/Server.Api.csproj" -c Release -o "$task_output/host" --nologo
(
  cd "$task_work/host/src/Client.Web"
  npm ci
  npm run build
)
cp -a -- "$task_work/host/src/Client.Web/dist" "$task_output/host/wwwroot"
chmod -R a+rX -- "$task_output/plugin" "$task_output/host"
echo "Built matching plugin, host API and web UI in $task_output"
