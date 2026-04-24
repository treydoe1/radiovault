const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const keychainProfile = process.env.NOTARY_KEYCHAIN_PROFILE;
  if (!keychainProfile) {
    console.log('  • skipped macOS notarization  reason=NOTARY_KEYCHAIN_PROFILE not set');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`  • notarizing       app=${appPath} profile=${keychainProfile}`);

  await notarize({
    appPath,
    tool: 'notarytool',
    keychainProfile,
  });

  console.log('  • notarization complete');
};
