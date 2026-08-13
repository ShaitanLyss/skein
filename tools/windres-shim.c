/* A `windres` that survives Windows paths.
 *
 * There is no MSVC toolchain on this machine (no cl.exe, no Windows SDK, and no
 * local admin to install one), so skein builds against the x86_64-pc-windows-gnu
 * toolchain with Cygwin's mingw-w64 cross compiler. The one thing that does not
 * survive that combination is the resource compiler: tauri-build → tauri-winres →
 * embed-resource runs bare `windres` with cargo's OUT_DIR, which is a backslashed
 * Windows path, and Cygwin's windres builds a *shell command string* to drive
 * `gcc -E`. The preprocessor then reads the backslashes as escapes and eats them:
 *
 *   cc1: fatal error: C:Userslyss.delpratworkbenchskein...outresource.rc
 *
 * Probed 2026-08-13 against GNU windres (binutils) 2.46 from C:\cygwin\bin: the
 * exact same invocation with forward slashes compiles the .rc without complaint.
 * So this shim rewrites `\` to `/` in every argument and delegates. embed-resource
 * 3.0.11 only ever spawns the bare name `windres` on non-msvc targets — it reads
 * no $RC override on that path — so the interception has to happen on PATH.
 *
 * Build (see tools/build-gnu.ps1, which does this for you):
 *   x86_64-w64-mingw32-gcc -O2 -o windres.exe tools/windres-shim.c
 * and put the result on PATH *ahead* of C:\cygwin\bin for the build only. Naming
 * it windres.exe globally would shadow the real one for everything else.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <process.h>

/* Delegate to the real thing by absolute path, or this shim finds itself. */
#define REAL_WINDRES "C:/cygwin/bin/windres.exe"

int main(int argc, char **argv) {
  const char *real = getenv("SKEIN_REAL_WINDRES");
  if (!real || !*real) real = REAL_WINDRES;

  const char **av = malloc((size_t)(argc + 1) * sizeof *av);
  if (!av) {
    fprintf(stderr, "windres-shim: out of memory\n");
    return 1;
  }
  av[0] = real;
  for (int i = 1; i < argc; i++) {
    char *s = strdup(argv[i]);
    if (!s) {
      fprintf(stderr, "windres-shim: out of memory\n");
      return 1;
    }
    for (char *p = s; *p; p++)
      if (*p == '\\') *p = '/';
    av[i] = s;
  }
  av[argc] = NULL;

  intptr_t rc = _spawnv(_P_WAIT, real, av);
  if (rc < 0) {
    perror(real);
    return 1;
  }
  return (int)rc;
}
