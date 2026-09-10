function errorHandler(err, _req, res, _next) {
  console.error(' API Error:', err);
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Terjadi kesalahan pada server';
  res.status(statusCode).json({ error: message });
}

module.exports = errorHandler;
