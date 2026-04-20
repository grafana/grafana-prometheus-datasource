const sharedConfig = require('../../jest.config.js');
module.exports = {
  ...sharedConfig,
  rootDir: '../../',
  modulePaths: ['<rootDir>/packages/grafana-prometheus/src'],
  testMatch: [
    '<rootDir>/packages/grafana-prometheus/src/**/__tests__/**/*.{js,jsx,ts,tsx}',
    '<rootDir>/packages/grafana-prometheus/src/**/*.{spec,test,jest}.{js,jsx,ts,tsx}',
  ],
};
