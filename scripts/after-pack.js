'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

// Electron 既定の Info.plist には Camera/Microphone/Bluetooth の使用許可文言と
// ATS 緩和(NSAllowsArbitraryLoads)が含まれる。本アプリは file:// と HTTPS の
// フォント取得のみで、これらの権限・HTTP 緩和は不要なので配布ビルドから取り除く。
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const plist = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist'
  );

  const cmds = [
    'Delete :NSCameraUsageDescription',
    'Delete :NSMicrophoneUsageDescription',
    'Delete :NSBluetoothAlwaysUsageDescription',
    'Delete :NSBluetoothPeripheralUsageDescription',
    'Delete :NSAppTransportSecurity:NSAllowsArbitraryLoads',
    'Delete :NSAppTransportSecurity:NSAllowsLocalNetworking'
  ];
  for (const c of cmds) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', c, plist]);
    } catch {
      // キーが存在しない場合は無視(Electron のバージョン差を許容)
    }
  }
};
