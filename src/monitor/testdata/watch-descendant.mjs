// A real child of the producer, inheriting its process group. Deliberately
// ignores TERM and holds inherited output pipes like a stuck ssh subprocess.
process.on('SIGTERM', () => {});
process.stdout.write(`DESCENDANT ${process.pid}\n`);
setTimeout(() => process.exit(99), 10_000);
