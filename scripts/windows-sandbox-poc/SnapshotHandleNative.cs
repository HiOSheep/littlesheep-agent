using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class LsHandleSnapshotResult {
  public string FileSystem { get; set; }
  public string SourceRootIdentity { get; set; }
  public int EntryCount { get; set; }
  public int FileCount { get; set; }
  public int DirectoryCount { get; set; }
  public int HardLinkedFileCount { get; set; }
  public int ReparsePointCount { get; set; }
  public int NamedStreamFileCount { get; set; }
  public int UnknownStreamStatusCount { get; set; }
  public long LogicalBytes { get; set; }
  public long CopiedBytes { get; set; }
  public long SourceAllocatedBytes { get; set; }
  public long DestinationAllocatedBytes { get; set; }
  public long ElapsedMilliseconds { get; set; }
  public bool Promoted { get; set; }
  public bool SourceDirectorySwapWasAttempted { get; set; }
  public bool RejectedForUnsupportedObject { get; set; }
  public string SourceDirectorySwapRelativePath { get; set; }
  public string SourceDirectorySwapResult { get; set; }
  public bool SourceEntrySwapWasAttempted { get; set; }
  public string SourceEntrySwapRelativePath { get; set; }
  public string SourceEntrySwapResult { get; set; }
  public List<string> UnsupportedObjects { get; private set; }
  public List<string> MaterializedHardlinks { get; private set; }
  public List<string> CopiedFileObjects { get; private set; }

  public LsHandleSnapshotResult() {
    UnsupportedObjects = new List<string>();
    MaterializedHardlinks = new List<string>();
    CopiedFileObjects = new List<string>();
  }
}

/// <summary>
/// Windows-only P3-A4 experiment. It opens each child relative to a retained
/// directory handle and copies bytes through the already validated file handle.
/// This is not a production snapshotter or an OS sandbox.
/// </summary>
public static class LsHandleSnapshotNative {
  private const uint FileListDirectory = 0x0001;
  private const uint FileReadData = 0x0001;
  private const uint FileReadAttributes = 0x0080;
  private const uint Synchronize = 0x00100000;
  private const uint FileShareRead = 0x00000001;
  private const uint FileShareWrite = 0x00000002;
  private const uint FileShareDelete = 0x00000004;
  private const uint OpenExisting = 3;
  private const uint CreateNew = 1;
  private const uint FileFlagBackupSemantics = 0x02000000;
  private const uint FileFlagOpenReparsePoint = 0x00200000;
  private const uint FileFlagSequentialScan = 0x08000000;
  private const uint FileAttributeNormal = 0x00000080;
  private const uint FileAttributeDirectory = 0x00000010;
  private const uint FileAttributeReparsePoint = 0x00000400;
  private const uint FileAttributeDevice = 0x00000040;
  private const uint FileAttributeSparseFile = 0x00000200;
  private const uint FileAttributeOffline = 0x00001000;
  private const uint FileAttributeEncrypted = 0x00004000;
  private const uint FileAttributeRecallOnOpen = 0x00040000;
  private const uint FileAttributeRecallOnDataAccess = 0x00400000;
  private const uint FileSynchronousIoNonAlert = 0x00000020;
  private const uint FileOpen = 1;
  private const uint FileOpenReparsePoint = 0x00200000;
  private const uint ObjCaseInsensitive = 0x00000040;
  private const int FileStandardInfo = 1;
  private const int FileStreamInfo = 7;
  private const int FileAttributeTagInfo = 9;
  private const int FileIdBothDirectoryInfo = 10;
  private const int FileIdBothDirectoryRestartInfo = 11;
  private const int ErrorNoMoreFiles = 18;
  private const int NtStatusNoMoreFiles = unchecked((int)0x80000006);
  private const int MaximumEntries = 500000;
  private const int MaximumNameLength = 32760;

  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeString {
    public ushort Length;
    public ushort MaximumLength;
    public IntPtr Buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes {
    public int Length;
    public IntPtr RootDirectory;
    public IntPtr ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor;
    public IntPtr SecurityQualityOfService;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatusBlock {
    public IntPtr Status;
    public IntPtr Information;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime {
    public uint Low;
    public uint High;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ByHandleFileInformation {
    public uint FileAttributes;
    public FileTime CreationTime;
    public FileTime LastAccessTime;
    public FileTime LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint desiredAccess, uint shareMode,
    IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation information);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, IntPtr information, uint size);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetVolumeInformationW(string rootPath, StringBuilder volumeName, int volumeNameSize,
    out uint serialNumber, out uint maximumComponentLength, out uint fileSystemFlags,
    StringBuilder fileSystemName, int fileSystemNameSize);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetDriveTypeW(string rootPath);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateHardLinkW(string linkName, string existingFileName, IntPtr securityAttributes);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.I1)]
  public static extern bool CreateSymbolicLinkW(string symlinkFileName, string targetFileName, uint flags);

  public static void WriteNamedStreamFixture(string filePath, string streamName, string content) {
    if (String.IsNullOrEmpty(streamName) || streamName.IndexOfAny(new char[] { ':', '\\', '/' }) >= 0)
      throw new ArgumentException("Invalid fixture stream name.");
    using (SafeFileHandle streamHandle = CreateFileW(filePath + ":" + streamName, 0x40000000,
      FileShareRead, IntPtr.Zero, CreateNew, FileAttributeNormal, IntPtr.Zero)) {
      if (streamHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create named-stream fixture.");
      using (var stream = new FileStream(streamHandle, FileAccess.Write, 4096, false)) {
        byte[] bytes = Encoding.UTF8.GetBytes(content);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(true);
      }
    }
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint desiredAccess, uint shareMode,
    IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, SafeFileHandle templateFile);

  [DllImport("ntdll.dll")]
  private static extern int NtCreateFile(out IntPtr fileHandle, uint desiredAccess,
    ref ObjectAttributes objectAttributes, out IoStatusBlock ioStatusBlock, IntPtr allocationSize,
    uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions,
    IntPtr eaBuffer, uint eaLength);

  [DllImport("ntdll.dll")]
  private static extern uint RtlNtStatusToDosError(int status);

  public static LsHandleSnapshotResult Analyze(string sourceRoot) {
    return Run(sourceRoot, null, null, null, null, null);
  }

  public static LsHandleSnapshotResult Copy(string sourceRoot, string destinationRoot,
    string pauseRelativeDirectory, string readyMarker, string releaseMarker) {
    if (String.IsNullOrEmpty(destinationRoot)) throw new ArgumentException("Destination is required.");
    return Run(sourceRoot, destinationRoot, pauseRelativeDirectory, null, readyMarker, releaseMarker);
  }

  public static LsHandleSnapshotResult CopyWithEntryPause(string sourceRoot, string destinationRoot,
    string pauseRelativeEntry, string readyMarker, string releaseMarker) {
    if (String.IsNullOrEmpty(destinationRoot)) throw new ArgumentException("Destination is required.");
    return Run(sourceRoot, destinationRoot, null, pauseRelativeEntry, readyMarker, releaseMarker);
  }

  private static LsHandleSnapshotResult Run(string sourceRoot, string destinationRoot,
    string pauseRelativeDirectory, string pauseRelativeEntry, string readyMarker, string releaseMarker) {
    var result = new LsHandleSnapshotResult();
    var timer = System.Diagnostics.Stopwatch.StartNew();
    string fullSource = Path.GetFullPath(sourceRoot);
    string driveRoot = Path.GetPathRoot(fullSource);
    if (String.IsNullOrEmpty(driveRoot) || driveRoot.Length != 3 || driveRoot[1] != ':')
      throw new NotSupportedException("Only a local drive-letter NTFS volume is supported by this experiment.");
    if (GetDriveTypeW(driveRoot) != 3)
      throw new NotSupportedException("Only a fixed local drive is supported by this experiment.");
    var fsName = new StringBuilder(64);
    uint serial, maxComponent, flags;
    if (!GetVolumeInformationW(driveRoot, null, 0, out serial, out maxComponent, out flags, fsName, fsName.Capacity))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "GetVolumeInformationW failed.");
    result.FileSystem = fsName.ToString();
    if (!String.Equals(result.FileSystem, "NTFS", StringComparison.OrdinalIgnoreCase))
      throw new NotSupportedException("Only NTFS is accepted; observed " + result.FileSystem + ".");

    string destination = destinationRoot == null ? null : Path.GetFullPath(destinationRoot);
    if (destination != null && Directory.Exists(destination)) throw new IOException("Destination already exists.");
    string stage = destination == null ? null : Path.Combine(Path.GetDirectoryName(destination), ".handle-snapshot-stage-" + Guid.NewGuid().ToString("N"));
    if (stage != null) Directory.CreateDirectory(stage);
    try {
      using (SafeFileHandle root = OpenSourceRoot(fullSource, driveRoot)) {
        result.SourceRootIdentity = Identity(root).FileId;
        string normalizedPause = String.IsNullOrEmpty(pauseRelativeDirectory) ? null : pauseRelativeDirectory.Replace('/', '\\').Trim('\\');
        string normalizedEntryPause = String.IsNullOrEmpty(pauseRelativeEntry) ? null : pauseRelativeEntry.Replace('/', '\\').Trim('\\');
        Walk(root, "", stage, result, normalizedPause, normalizedEntryPause, readyMarker, releaseMarker);
      }
      if (result.EntryCount > MaximumEntries) throw new IOException("Entry budget exceeded; snapshot refused.");
      if (result.UnsupportedObjects.Count > 0) {
        if (stage != null) Directory.Delete(stage, true);
        stage = null;
      } else if (destination != null) {
        if (!MoveFile(stage, destination, 0x00000008))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Atomic same-parent snapshot promotion failed.");
        stage = null;
        result.Promoted = true;
      }
    } finally {
      if (stage != null && Directory.Exists(stage)) {
        try { Directory.Delete(stage, true); } catch { }
      }
      timer.Stop();
      result.ElapsedMilliseconds = timer.ElapsedMilliseconds;
    }
    return result;
  }

  private static bool MoveFile(string existing, string destination, uint flags) {
    return MoveFileExW(existing, destination, flags);
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool MoveFileExW(string existing, string destination, uint flags);

  private static SafeFileHandle OpenSourceRoot(string fullSource, string driveRoot) {
    const uint allShare = FileShareRead | FileShareWrite | FileShareDelete;
    SafeFileHandle current = CreateFileW("\\\\?\\" + driveRoot, FileListDirectory | FileReadAttributes | Synchronize,
      allShare, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
    if (current.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open volume root handle.");
    try {
      string relative = fullSource.Substring(driveRoot.Length).Trim('\\');
      if (relative.Length == 0) return current;
      foreach (string component in relative.Split('\\')) {
        ValidateComponent(component);
        SafeFileHandle next = OpenRelative(current, component,
          FileReadData | FileReadAttributes | Synchronize, allShare,
          FileOpenReparsePoint | FileSynchronousIoNonAlert);
        var identity = Identity(next);
        if ((identity.Attributes & FileAttributeReparsePoint) != 0)
          throw new IOException("Source root path contains a reparse point: " + component);
        if ((identity.Attributes & FileAttributeDirectory) == 0)
          throw new IOException("Source root path component is not a directory: " + component);
        current.Dispose();
        current = next;
      }
      return current;
    } catch {
      current.Dispose();
      throw;
    }
  }

  private static void ValidateComponent(string name) {
    if (String.IsNullOrEmpty(name) || name == "." || name == ".." || name.IndexOfAny(new char[] { '\\', '/', ':' }) >= 0)
      throw new IOException("Ambiguous or invalid path component rejected.");
    if (name.Length > MaximumNameLength || name.EndsWith(" ", StringComparison.Ordinal) || name.EndsWith(".", StringComparison.Ordinal))
      throw new IOException("Unsupported Windows path component rejected.");
  }

  private static SafeFileHandle OpenRelative(SafeFileHandle parent, string name, uint desiredAccess,
    uint shareAccess, uint createOptions) {
    ValidateComponent(name);
    IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
    IntPtr unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
    bool added = false;
    try {
      var unicode = new UnicodeString();
      unicode.Length = checked((ushort)(name.Length * 2));
      unicode.MaximumLength = checked((ushort)((name.Length + 1) * 2));
      unicode.Buffer = nameBuffer;
      Marshal.StructureToPtr(unicode, unicodeBuffer, false);
      var attributes = new ObjectAttributes();
      attributes.Length = Marshal.SizeOf(typeof(ObjectAttributes));
      attributes.RootDirectory = parent.DangerousGetHandle();
      attributes.ObjectName = unicodeBuffer;
      attributes.Attributes = ObjCaseInsensitive;
      parent.DangerousAddRef(ref added);
      IntPtr fileHandle;
      IoStatusBlock ioStatus;
      int status = NtCreateFile(out fileHandle, desiredAccess, ref attributes, out ioStatus, IntPtr.Zero,
        FileAttributeNormal, shareAccess, FileOpen, createOptions | FileOpenReparsePoint | FileSynchronousIoNonAlert,
        IntPtr.Zero, 0);
      if (status < 0) {
        uint error = RtlNtStatusToDosError(status);
        throw new Win32Exception(unchecked((int)error), "NtCreateFile relative open failed, NTSTATUS=0x" + unchecked((uint)status).ToString("X8"));
      }
      if (fileHandle == IntPtr.Zero || fileHandle == new IntPtr(-1)) throw new IOException("NtCreateFile returned an invalid handle.");
      return new SafeFileHandle(fileHandle, true);
    } finally {
      if (added) parent.DangerousRelease();
      Marshal.FreeHGlobal(unicodeBuffer);
      Marshal.FreeHGlobal(nameBuffer);
    }
  }

  private sealed class IdentityInfo {
    public string FileId;
    public ulong FileIndex;
    public uint LinkCount;
    public uint Attributes;
    public long Size;
    public long LastWrite;
    public long AllocationSize;
  }

  private static IdentityInfo Identity(SafeFileHandle handle) {
    ByHandleFileInformation info;
    if (!GetFileInformationByHandle(handle, out info))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandle failed.");
    IntPtr standard = Marshal.AllocHGlobal(24);
    try {
      if (!GetFileInformationByHandleEx(handle, FileStandardInfo, standard, 24))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "FileStandardInfo query failed.");
      long allocation = Marshal.ReadInt64(standard, 0);
      long size = Marshal.ReadInt64(standard, 8);
      long lastWrite = unchecked((long)(((ulong)info.LastWriteTime.High << 32) | info.LastWriteTime.Low));
      return new IdentityInfo {
        FileId = info.VolumeSerialNumber.ToString("X8") + ":" + info.FileIndexHigh.ToString("X8") + info.FileIndexLow.ToString("X8"),
        FileIndex = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow,
        LinkCount = info.NumberOfLinks,
        Attributes = info.FileAttributes,
        Size = size,
        LastWrite = lastWrite,
        AllocationSize = allocation
      };
    } finally { Marshal.FreeHGlobal(standard); }
  }

  private static uint GetReparseTag(SafeFileHandle handle) {
    IntPtr tagInfo = Marshal.AllocHGlobal(8);
    try {
      if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, tagInfo, 8))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "FileAttributeTagInfo query failed.");
      return unchecked((uint)Marshal.ReadInt32(tagInfo, 4));
    } finally { Marshal.FreeHGlobal(tagInfo); }
  }

  private static List<string> GetStreams(SafeFileHandle handle) {
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      if (!GetFileInformationByHandleEx(handle, FileStreamInfo, buffer, 65536))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "FileStreamInfo handle query failed; named streams cannot be excluded.");
      var streams = new List<string>();
      int offset = 0;
      while (true) {
        if (offset < 0 || offset + 24 > 65536) throw new IOException("Malformed stream information buffer.");
        int next = Marshal.ReadInt32(buffer, offset);
        int nameBytes = Marshal.ReadInt32(buffer, offset + 4);
        if (nameBytes < 0 || (nameBytes & 1) != 0 || offset + 24 + nameBytes > 65536)
          throw new IOException("Malformed stream name information.");
        streams.Add(Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 24), nameBytes / 2));
        if (next == 0) break;
        if (next < 24 || (next & 7) != 0) throw new IOException("Invalid stream record offset.");
        offset = checked(offset + next);
      }
      return streams;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  private sealed class DirectoryEntry {
    public string Name;
    public ulong FileId;
    public uint EnumerationAttributes;
  }

  private static List<DirectoryEntry> ReadDirectory(SafeFileHandle directory) {
    var entries = new List<DirectoryEntry>();
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    bool restart = true;
    try {
      while (true) {
        int error;
        int infoClass = restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo;
        restart = false;
        if (!GetFileInformationByHandleEx(directory, infoClass, buffer, 65536)) {
          error = Marshal.GetLastWin32Error();
          if (error == ErrorNoMoreFiles) break;
          throw new Win32Exception(error, "Handle-based directory enumeration failed.");
        }
        int offset = 0;
        while (true) {
          if (offset < 0 || offset + 104 > 65536) throw new IOException("Malformed directory enumeration buffer.");
          int next = Marshal.ReadInt32(buffer, offset);
          int nameBytes = Marshal.ReadInt32(buffer, offset + 60);
          if (nameBytes < 0 || (nameBytes & 1) != 0 || offset + 104 + nameBytes > 65536)
            throw new IOException("Malformed directory entry name.");
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 104), nameBytes / 2);
          if (name != "." && name != "..") {
            if (entries.Count >= MaximumEntries) throw new IOException("Entry budget exceeded during directory enumeration.");
            entries.Add(new DirectoryEntry {
              Name = name,
              EnumerationAttributes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 56)),
              FileId = unchecked((ulong)Marshal.ReadInt64(buffer, offset + 96))
            });
          }
          if (next == 0) break;
          if (next < 104 || offset + next >= 65536) throw new IOException("Invalid directory record offset.");
          offset = checked(offset + next);
        }
      }
      return entries;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  private static void Walk(SafeFileHandle directory, string relative, string destinationDirectory,
    LsHandleSnapshotResult result, string pauseRelativeDirectory, string pauseRelativeEntry,
    string readyMarker, string releaseMarker) {
    if (destinationDirectory != null) Directory.CreateDirectory(destinationDirectory);
    if (!String.IsNullOrEmpty(pauseRelativeDirectory) && String.Equals(relative.Trim('\\'), pauseRelativeDirectory, StringComparison.OrdinalIgnoreCase)) {
      result.SourceDirectorySwapWasAttempted = true;
      result.SourceDirectorySwapRelativePath = relative;
      if (String.IsNullOrEmpty(readyMarker) || String.IsNullOrEmpty(releaseMarker))
        throw new ArgumentException("Race markers are required when pausing snapshot traversal.");
      File.WriteAllText(readyMarker, "opened-and-pinned");
      var wait = System.Diagnostics.Stopwatch.StartNew();
      while (!File.Exists(releaseMarker)) {
        if (wait.ElapsedMilliseconds > 20000) throw new TimeoutException("Timed out waiting for independent directory-replacement attempt.");
        System.Threading.Thread.Sleep(20);
      }
      result.SourceDirectorySwapResult = File.ReadAllText(releaseMarker);
    }

    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (DirectoryEntry entry in ReadDirectory(directory)) {
      ValidateComponent(entry.Name);
      string childRelative = relative.Length == 0 ? entry.Name : relative + "\\" + entry.Name;
      if (!names.Add(entry.Name)) {
        result.EntryCount++;
        result.UnsupportedObjects.Add("destination-name-collision:" + childRelative);
        continue;
      }
      if (pauseRelativeEntry != null && String.Equals(childRelative, pauseRelativeEntry, StringComparison.OrdinalIgnoreCase)) {
        result.SourceEntrySwapWasAttempted = true;
        result.SourceEntrySwapRelativePath = childRelative;
        if (String.IsNullOrEmpty(readyMarker) || String.IsNullOrEmpty(releaseMarker))
          throw new ArgumentException("Race markers are required when pausing before opening a source entry.");
        File.WriteAllText(readyMarker, "enumerated-before-entry-open");
        var wait = System.Diagnostics.Stopwatch.StartNew();
        while (!File.Exists(releaseMarker)) {
          if (wait.ElapsedMilliseconds > 20000) throw new TimeoutException("Timed out waiting for independent file-entry replacement attempt.");
          System.Threading.Thread.Sleep(20);
        }
        result.SourceEntrySwapResult = File.ReadAllText(releaseMarker);
      }
      bool directoryHint = (entry.EnumerationAttributes & FileAttributeDirectory) != 0;
      bool reparseHint = (entry.EnumerationAttributes & FileAttributeReparsePoint) != 0;
      uint access = FileReadAttributes | Synchronize;
      if (directoryHint) access |= FileListDirectory;
      else if (!reparseHint && destinationDirectory != null) access |= FileReadData;
      uint share = directoryHint ? FileShareRead | FileShareWrite | FileShareDelete : FileShareRead;
      using (SafeFileHandle child = OpenRelative(directory, entry.Name, access, share, FileOpenReparsePoint | FileSynchronousIoNonAlert)) {
        IdentityInfo id = Identity(child);
        if (entry.FileId != id.FileIndex)
          throw new IOException("Entry identity changed between handle enumeration and relative open: " + childRelative);
        if (((id.Attributes & FileAttributeDirectory) != 0) != directoryHint)
          throw new IOException("Entry type changed between handle enumeration and open: " + childRelative);
        result.EntryCount++;
        if (result.EntryCount > MaximumEntries) throw new IOException("Entry budget exceeded.");

        if ((id.Attributes & FileAttributeReparsePoint) != 0) {
          uint tag = GetReparseTag(child);
          result.ReparsePointCount++;
          result.UnsupportedObjects.Add("reparse:" + childRelative + ":0x" + tag.ToString("X8"));
          if (destinationDirectory != null) { result.RejectedForUnsupportedObject = true; return; }
          continue;
        }
        if ((id.Attributes & (FileAttributeDevice | FileAttributeSparseFile | FileAttributeOffline | FileAttributeEncrypted |
          FileAttributeRecallOnOpen | FileAttributeRecallOnDataAccess)) != 0) {
          result.UnsupportedObjects.Add("special-attributes:" + childRelative + ":0x" + id.Attributes.ToString("X8"));
          if (destinationDirectory != null) { result.RejectedForUnsupportedObject = true; return; }
          continue;
        }

        if (directoryHint) {
          result.DirectoryCount++;
          if (destinationDirectory != null) Directory.CreateDirectory(Path.Combine(destinationDirectory, entry.Name));
          Walk(child, childRelative, destinationDirectory == null ? null : Path.Combine(destinationDirectory, entry.Name),
            result, pauseRelativeDirectory, pauseRelativeEntry, readyMarker, releaseMarker);
          if (destinationDirectory != null && result.RejectedForUnsupportedObject) return;
          continue;
        }

        result.FileCount++;
        result.LogicalBytes = checked(result.LogicalBytes + id.Size);
        result.SourceAllocatedBytes = checked(result.SourceAllocatedBytes + id.AllocationSize);
        if (id.LinkCount > 1) {
          result.HardLinkedFileCount++;
          result.MaterializedHardlinks.Add(childRelative + ":links=" + id.LinkCount.ToString());
        }

        List<string> streams = GetStreams(child);
        bool hasDefaultStream = false;
        foreach (string stream in streams) {
          if (String.Equals(stream, "::$DATA", StringComparison.OrdinalIgnoreCase)) hasDefaultStream = true;
        }
        if (streams.Count == 0 || !hasDefaultStream) {
          result.UnknownStreamStatusCount++;
          result.UnsupportedObjects.Add("default-stream-unconfirmed:" + childRelative);
          if (destinationDirectory != null) { result.RejectedForUnsupportedObject = true; return; }
          continue;
        }
        if (streams.Count != 1) {
          result.NamedStreamFileCount++;
          result.UnsupportedObjects.Add("named-stream:" + childRelative + ":" + String.Join(",", streams.ToArray()));
          if (destinationDirectory != null) { result.RejectedForUnsupportedObject = true; return; }
          continue;
        }

        if (destinationDirectory != null) {
          string destPath = Path.Combine(destinationDirectory, entry.Name);
          IdentityInfo copied = CopyFromPinnedHandle(child, destPath, id);
          result.CopiedBytes = checked(result.CopiedBytes + copied.Size);
          result.DestinationAllocatedBytes = checked(result.DestinationAllocatedBytes + copied.AllocationSize);
          result.CopiedFileObjects.Add(childRelative + ":source=" + id.FileId + ":links=" + id.LinkCount + ":copy=" + copied.FileId);
        }
      }
    }
  }

  private static IdentityInfo CopyFromPinnedHandle(SafeFileHandle source, string destination, IdentityInfo before) {
    string copiedSourceHash = null;
    SafeFileHandle output = CreateFileW(destination, 0x40000000, FileShareRead, IntPtr.Zero,
      CreateNew, FileAttributeNormal | FileFlagSequentialScan, IntPtr.Zero);
    if (output.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "CREATE_NEW for snapshot file failed.");
    using (output) {
      using (var sourceView = new SafeFileHandle(source.DangerousGetHandle(), false))
      using (var input = new FileStream(sourceView, FileAccess.Read, 1024 * 1024, false))
      using (var outputStream = new FileStream(output, FileAccess.Write, 1024 * 1024, false))
      using (var sourceHash = SHA256.Create()) {
        using (var hashingOutput = new CryptoStream(outputStream, sourceHash, CryptoStreamMode.Write, true)) {
          input.CopyTo(hashingOutput, 1024 * 1024);
          hashingOutput.FlushFinalBlock();
        }
        outputStream.Flush(true);
        copiedSourceHash = BitConverter.ToString(sourceHash.Hash).Replace("-", "");
      }
    }
    IdentityInfo after = Identity(source);
    IdentityInfo copied;
    using (SafeFileHandle verify = CreateFileW(destination, FileReadAttributes | FileReadData,
      FileShareRead, IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint, IntPtr.Zero)) {
      if (verify.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not reopen staged copy for identity verification.");
      copied = Identity(verify);
      if (copied.FileId == before.FileId || copied.LinkCount != 1)
        throw new IOException("Snapshot copy did not produce an independent single-link file object.");
      using (var sha = SHA256.Create()) {
        using (var stream = new FileStream(new SafeFileHandle(verify.DangerousGetHandle(), false), FileAccess.Read, 65536, false)) {
          byte[] digest = sha.ComputeHash(stream);
          string destinationHash = BitConverter.ToString(digest).Replace("-", "");
          if (digest.Length != 32 || destinationHash != copiedSourceHash)
            throw new IOException("Snapshot copy content hash differs from bytes read through the validated source handle.");
        }
      }
    }
    if (after.FileId != before.FileId || after.LinkCount != before.LinkCount || after.Size != before.Size || after.LastWrite != before.LastWrite)
      throw new IOException("Pinned source object changed while its bytes were copied.");
    if (copied.Size != before.Size) throw new IOException("Snapshot copy size differs from the pinned source object.");
    return copied;
  }
}
