/* Media Marshal：只提供普通文件的独占改名；授权与持久意图由 Core 持有。 */
#define NAPI_VERSION 8
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef __APPLE__
#error "本原语只构建 macOS；其他平台必须使用独立且已验证的实现"
#endif

typedef enum { OK, INVALID_SOURCE, SOURCE_CHANGED, TARGET_EXISTS, CROSS_VOLUME, UNAVAILABLE, UNSUPPORTED, SYNC_FAILED, INTERRUPTED, UNSAFE_PATH } result_code;
typedef struct { unsigned active, functions; } instance;
typedef struct { instance *owner; bool beneath, link_only; } binding;
typedef struct {
  napi_async_work work; napi_deferred deferred; instance *owner;
  int from_fd, to_fd, os_error; char from[256], to[256];
  bool beneath, link_only; size_t from_count, to_count; char from_parts[256][256], to_parts[256][256];
  uint64_t dev, ino, size; int64_t birth_ns, modified_ns, changed_ns;
  bool moved, uncertain, executed; result_code code;
} rename_job;

static bool own(napi_env env, napi_value object, const char *name, napi_value *value) {
  napi_value key; bool found;
  return napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &key) == napi_ok &&
    napi_has_own_property(env, object, key, &found) == napi_ok && found &&
    napi_get_property(env, object, key, value) == napi_ok;
}
static bool uint_field(napi_env env, napi_value object, const char *name, uint64_t *value) {
  napi_value field; bool lossless; return own(env, object, name, &field) && napi_get_value_bigint_uint64(env, field, value, &lossless) == napi_ok && lossless;
}
static bool int_field(napi_env env, napi_value object, const char *name, int64_t *value) {
  napi_value field; bool lossless; return own(env, object, name, &field) && napi_get_value_bigint_int64(env, field, value, &lossless) == napi_ok && lossless;
}
static bool fd_value(napi_env env, napi_value value, int *fd) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < 0 || number > INT_MAX || floor(number) != number) return false;
  *fd = (int)number; return true;
}
static bool leaf_value(napi_env env, napi_value value, char *name) {
  size_t length = 0, written = 0; napi_value roundtrip; bool equal;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > 255) return false;
  if (napi_get_value_string_utf8(env, value, name, 256, &written) != napi_ok || written != length || memchr(name, '\0', length) || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) return false;
  /* 拒绝 UTF-16 孤立代理项被替换为另一文件名。 */
  return napi_create_string_utf8(env, name, length, &roundtrip) == napi_ok && napi_strict_equals(env, value, roundtrip, &equal) == napi_ok && equal;
}
static bool parts_value(napi_env env, napi_value value, char parts[256][256], size_t *count) {
  bool array; uint32_t length;
  if (napi_is_array(env, value, &array) != napi_ok || !array || napi_get_array_length(env, value, &length) != napi_ok || length < 1 || length > 256) return false;
  for (uint32_t index = 0; index < length; index++) { napi_value part; if (napi_get_element(env, value, index, &part) != napi_ok || !leaf_value(env, part, parts[index])) return false; }
  *count = length; return true;
}
/* 逐层 openat，不让父目录中的符号链接把操作转到根外；跨设备子挂载同样阻断。 */
static int parent_beneath(int root, char parts[256][256], size_t count, bool create) {
  struct stat root_info, child; if (fstat(root, &root_info) || !S_ISDIR(root_info.st_mode)) { errno = ENOTDIR; return -1; }
  int fd = fcntl(root, F_DUPFD_CLOEXEC, 0); if (fd < 0) return -1;
  for (size_t index = 0; index + 1 < count; index++) {
    if (create && mkdirat(fd, parts[index], 0700) && errno != EEXIST) { int error = errno; close(fd); errno = error; return -1; }
    if (create && fsync(fd)) { int error = errno; close(fd); errno = error; return -1; }
    int next = openat(fd, parts[index], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), error = errno; close(fd);
    if (next < 0) { errno = error; return -1; }
    if (fstat(next, &child) || child.st_dev != root_info.st_dev) { close(next); errno = EXDEV; return -1; } fd = next;
  }
  return fd;
}
static bool ns_value(struct timespec time, int64_t *value) {
  __int128 result = (__int128)time.tv_sec * 1000000000 + time.tv_nsec;
  if (result < INT64_MIN || result > INT64_MAX) return false;
  *value = (int64_t)result; return true;
}
static bool matches(const rename_job *job, const struct stat *info, bool before) {
  int64_t birth, modified, changed;
  return S_ISREG(info->st_mode) && (uint64_t)info->st_dev == job->dev && (uint64_t)info->st_ino == job->ino && info->st_size >= 0 && (uint64_t)info->st_size == job->size &&
    ns_value(info->st_birthtimespec, &birth) && birth == job->birth_ns && ns_value(info->st_mtimespec, &modified) && modified == job->modified_ns &&
    (!before || (ns_value(info->st_ctimespec, &changed) && changed == job->changed_ns));
}
static result_code classify(int error) {
  if (error == EEXIST || error == ENOTEMPTY || error == EISDIR) return TARGET_EXISTS;
  if (error == EXDEV) return CROSS_VOLUME;
  if (error == ENOTSUP || error == EINVAL || error == ENOSYS) return UNSUPPORTED;
  return UNAVAILABLE;
}
static void perform(rename_job *job, int from, int to) {
  struct stat file;
  if (fstatat(from, job->from, &file, AT_SYMLINK_NOFOLLOW)) { job->os_error = errno; job->code = UNAVAILABLE; return; }
  if (!S_ISREG(file.st_mode)) { job->code = INVALID_SOURCE; return; }
  if (!matches(job, &file, true)) { job->code = SOURCE_CHANGED; return; }
  if (job->link_only ? linkat(from, job->from, to, job->to, 0) : renameatx_np(from, job->from, to, job->to, RENAME_EXCL)) { job->os_error = errno; job->code = classify(errno); return; }
  job->moved = true;
  int observed = fstatat(to, job->to, &file, AT_SYMLINK_NOFOLLOW);
  if (observed || !matches(job, &file, false)) { job->os_error = observed ? errno : 0; job->code = SOURCE_CHANGED; job->uncertain = true; return; }
  if (fsync(from) || fsync(to)) { job->os_error = errno; job->code = SYNC_FAILED; job->uncertain = true; }
}
static void execute(napi_env env, void *data) {
  (void)env; rename_job *job = data; struct stat from_parent, to_parent, file;
  job->executed = true; if (job->code != OK) return;
  if (fstat(job->from_fd, &from_parent) || fstat(job->to_fd, &to_parent)) { job->os_error = errno; job->code = UNAVAILABLE; return; }
  if (!S_ISDIR(from_parent.st_mode) || !S_ISDIR(to_parent.st_mode)) { job->code = UNAVAILABLE; job->os_error = ENOTDIR; return; }
  if (!job->beneath) { perform(job, job->from_fd, job->to_fd); return; }
  if (from_parent.st_dev != to_parent.st_dev) { job->code = CROSS_VOLUME; job->os_error = EXDEV; return; }
  int from = parent_beneath(job->from_fd, job->from_parts, job->from_count, false), to = -1;
  if (from < 0) { job->code = errno == ELOOP || errno == ENOTDIR || errno == EXDEV ? UNSAFE_PATH : UNAVAILABLE; job->os_error = errno; return; }
  /* 目标目录只在来源身份核对后创建，且同样按根 FD 逐层进入。 */
  if (fstatat(from, job->from, &file, AT_SYMLINK_NOFOLLOW)) { job->code = UNAVAILABLE; job->os_error = errno; }
  else if (!S_ISREG(file.st_mode)) job->code = INVALID_SOURCE;
  else if (!matches(job, &file, true)) job->code = SOURCE_CHANGED;
  else {
    to = parent_beneath(job->to_fd, job->to_parts, job->to_count, true);
    if (to < 0) { job->code = errno == ELOOP || errno == ENOTDIR || errno == EXDEV ? UNSAFE_PATH : UNAVAILABLE; job->os_error = errno; }
    else perform(job, from, to);
  }
  close(from); if (to >= 0) close(to);
}
static void release(rename_job *job) { if (job->from_fd >= 0) close(job->from_fd); if (job->to_fd >= 0) close(job->to_fd); free(job); }
static void string_property(napi_env env, napi_value object, const char *name, const char *value) { napi_value field; napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &field); napi_set_named_property(env, object, name, field); }
static void complete(napi_env env, napi_status status, void *data) {
  rename_job *job = data;
  if (env) {
    if (status != napi_ok) { job->code = INTERRUPTED; job->uncertain = job->moved; }
    const char *codes[] = { "OK", "INVALID_SOURCE", "SOURCE_CHANGED", "TARGET_EXISTS", "CROSS_VOLUME", "UNAVAILABLE", "UNSUPPORTED", "SYNC_FAILED", "INTERRUPTED", "UNSAFE_PATH" };
    napi_value result, value; napi_create_object(env, &result);
    string_property(env, result, "state", job->uncertain ? "UNCERTAIN" : job->moved ? (job->link_only ? "PUBLISHED" : "RENAMED") : (job->link_only ? "NOT_PUBLISHED" : "NOT_RENAMED")); string_property(env, result, "code", codes[job->code]);
    napi_get_boolean(env, job->moved, &value); napi_set_named_property(env, result, job->link_only ? "published" : "moved", value);
    napi_create_int32(env, job->os_error, &value); napi_set_named_property(env, result, "osError", value);
    napi_resolve_deferred(env, job->deferred, result); napi_delete_async_work(env, job->work);
  }
  job->owner->active--; if (!job->owner->functions && !job->owner->active) free(job->owner);
  release(job);
}
static napi_value rename_exclusive(napi_env env, napi_callback_info info) {
  napi_value args[6], keys, promise, label; size_t count = 6; uint32_t fields = 0; int from, to; binding *method = NULL; instance *owner;
  rename_job parsed = {0};
  if (napi_get_cb_info(env, info, &count, args, NULL, (void **)&method) != napi_ok || count != 5 || !method || !fd_value(env, args[0], &from) || !fd_value(env, args[2], &to) ||
    (method->beneath ? !parts_value(env, args[1], parsed.from_parts, &parsed.from_count) || !parts_value(env, args[3], parsed.to_parts, &parsed.to_count) : !leaf_value(env, args[1], parsed.from) || !leaf_value(env, args[3], parsed.to)) ||
    napi_get_all_property_names(env, args[4], napi_key_own_only, napi_key_all_properties, napi_key_numbers_to_strings, &keys) != napi_ok || napi_get_array_length(env, keys, &fields) != napi_ok || fields != 6 ||
    !uint_field(env, args[4], "dev", &parsed.dev) || !uint_field(env, args[4], "ino", &parsed.ino) || !uint_field(env, args[4], "size", &parsed.size) ||
    !int_field(env, args[4], "birthtimeNs", &parsed.birth_ns) || !int_field(env, args[4], "mtimeNs", &parsed.modified_ns) || !int_field(env, args[4], "ctimeNs", &parsed.changed_ns)) {
    bool pending = false; napi_is_exception_pending(env, &pending); if (!pending) napi_throw_type_error(env, "INVALID_INPUT", "独占改名参数无效"); return NULL;
  }
  owner = method->owner; parsed.beneath = method->beneath; parsed.link_only = method->link_only;
  if (parsed.beneath) { strcpy(parsed.from, parsed.from_parts[parsed.from_count - 1]); strcpy(parsed.to, parsed.to_parts[parsed.to_count - 1]); }
  if (owner->active >= 64) { napi_throw_error(env, "BUSY", "独占改名等待数已达上限"); return NULL; }
  rename_job *job = calloc(1, sizeof(*job)); if (!job) { napi_throw_error(env, "UNAVAILABLE", "独占改名资源不可用"); return NULL; }
  *job = parsed; job->owner = owner; job->from_fd = -1; job->to_fd = -1;
  job->from_fd = fcntl(from, F_DUPFD_CLOEXEC, 0); if (job->from_fd < 0) { job->code = UNAVAILABLE; job->os_error = errno; }
  job->to_fd = fcntl(to, F_DUPFD_CLOEXEC, 0); if (job->to_fd < 0) { job->code = UNAVAILABLE; job->os_error = errno; }
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok || napi_create_string_utf8(env, "media.correction.rename-exclusive", NAPI_AUTO_LENGTH, &label) != napi_ok || napi_create_async_work(env, NULL, label, execute, complete, job, &job->work) != napi_ok) { release(job); napi_throw_error(env, "UNAVAILABLE", "独占改名任务不可用"); return NULL; }
  owner->active++;
  if (napi_queue_async_work(env, job->work) != napi_ok) { owner->active--; napi_delete_async_work(env, job->work); release(job); napi_throw_error(env, "UNAVAILABLE", "独占改名无法排队"); return NULL; }
  return promise;
}
static void finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint; binding *method = data; instance *owner = method->owner;
  owner->functions--; if (!owner->functions && !owner->active) free(owner); free(method);
}
static bool add_method(napi_env env, napi_value exports, const char *name, instance *owner, bool beneath, bool link_only) {
  binding *method = calloc(1, sizeof(*method)); if (!method) return false; method->owner = owner; method->beneath = beneath; method->link_only = link_only;
  napi_value function;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, rename_exclusive, method, &function) != napi_ok || napi_add_finalizer(env, function, method, finalize, NULL, NULL) != napi_ok) { free(method); return false; }
  owner->functions++;
  napi_property_descriptor descriptor = { name, NULL, NULL, NULL, NULL, function, napi_default, NULL };
  return napi_define_properties(env, exports, 1, &descriptor) == napi_ok;
}
static napi_value init(napi_env env, napi_value exports) {
  instance *owner = calloc(1, sizeof(*owner)); if (!owner) return NULL;
  if (!add_method(env, exports, "renameExclusive", owner, false, false) || !add_method(env, exports, "renameBeneath", owner, true, false) || !add_method(env, exports, "linkBeneath", owner, true, true)) { if (!owner->functions) free(owner); return NULL; }
  return exports;
}
NAPI_MODULE(rename_exclusive, init)
