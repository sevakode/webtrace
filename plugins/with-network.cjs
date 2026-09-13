const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');
module.exports = function withNetwork(config) {
  config = withAndroidManifest(config, config => {
    config.modResults.manifest.application[0].$['android:usesCleartextTraffic'] = 'true';
    return config;
  });
  return withInfoPlist(config, config => {
    config.modResults.NSAppTransportSecurity = {
      ...(config.modResults.NSAppTransportSecurity || {}),
      NSAllowsArbitraryLoadsInWebContent: true,
      NSAllowsLocalNetworking: true,
    };
    config.modResults.UIFileSharingEnabled = true;
    config.modResults.LSSupportsOpeningDocumentsInPlace = true;
    return config;
  });
};
