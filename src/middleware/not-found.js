/** Runs when no route matched. Mounted after all routers. */
export function notFound(req, res) {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
}
