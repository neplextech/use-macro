module.exports = function useMacroNextLoader(source, inputSourceMap) {
  const callback = this.async();

  import('./next-loader.js')
    .then(({ runNextMacroLoader }) => {
      runNextMacroLoader(this, source, inputSourceMap, callback);
    })
    .catch((error) => callback(error));
};
