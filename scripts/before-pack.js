const { prepare } = require('./prepare-build');
module.exports = async (context) => {
  const { version } = prepare();
  if (context.packager.appInfo.version !== version) throw new Error('Build metadata does not match PROCTOR_CLIENT_VERSION');
};
