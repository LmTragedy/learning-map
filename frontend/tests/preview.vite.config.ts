import base from '../vite.config';

export default {
  ...base,
  server: {
    host: '127.0.0.1', port: 5177, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8766', '/test': 'http://127.0.0.1:8766' },
  },
};
