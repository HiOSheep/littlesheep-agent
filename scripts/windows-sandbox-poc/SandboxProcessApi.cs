using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class LsSandboxRunResult
{
    public int ExitCode { get; set; }
    public bool TimedOut { get; set; }
    public bool TreeTerminated { get; set; }
    public uint ProcessId { get; set; }
    public uint ResumePreviousSuspendCount { get; set; }
    public uint RootWaitBeforeTermination { get; set; }
    public uint RootExitCodeBeforeTermination { get; set; }
}

public static class LsWindowsSandboxProcess
{
    private const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const int FileAttributeTagInfo = 9;
    private const uint ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInformation
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private delegate bool CreateProcessInSandboxDelegate(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        string identity,
        [In] byte[] sandboxSpecification,
        uint sandboxSpecificationSize,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JobExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        IntPtr file,
        int informationClass,
        out FileAttributeTagInformation information,
        uint bufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    public static bool ApiAvailable(out string reason)
    {
        IntPtr module = LoadSandboxModule();
        if (module == IntPtr.Zero)
        {
            reason = "processmodel.dll could not be loaded from System32 (Win32 " + Marshal.GetLastWin32Error() + ")";
            return false;
        }

        IntPtr export = GetProcAddress(module, "Experimental_CreateProcessInSandbox");
        if (export == IntPtr.Zero)
        {
            reason = "Experimental_CreateProcessInSandbox export is unavailable";
            return false;
        }

        reason = "experimental processmodel export is present";
        return true;
    }

    public static bool DeleteProfile(string identity)
    {
        int result = DeleteAppContainerProfile(identity);
        if (result == 0 || result == unchecked((int)0x80070490)) return true;
        return false;
    }

    public static LsSandboxRunResult Run(
        string executable,
        string[] arguments,
        string workingDirectory,
        string currentDirectory,
        string identity,
        string specificationPath,
        string launchMarkerPath,
        string resultPath,
        string pathValue,
        string modulePathValue,
        int timeoutMilliseconds)
    {
        if (timeoutMilliseconds <= 0) throw new ArgumentOutOfRangeException("timeoutMilliseconds");
        string workspace = Path.GetFullPath(workingDirectory);
        if (!Directory.Exists(workspace)) throw new DirectoryNotFoundException(workspace);
        string processCurrentDirectory = String.IsNullOrWhiteSpace(currentDirectory)
            ? workspace
            : Path.GetFullPath(currentDirectory);
        if (!Directory.Exists(processCurrentDirectory)) throw new DirectoryNotFoundException(processCurrentDirectory);
        byte[] specification = File.ReadAllBytes(specificationPath);
        string pinPath = workspace.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (pinPath.Length == 2 && pinPath[1] == ':') pinPath += Path.DirectorySeparatorChar;

        IntPtr pinnedWorkspace = OpenPinnedDirectory(pinPath);
        IntPtr job = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        bool created = false;
        bool assigned = false;
        IntPtr environment = IntPtr.Zero;

        try
        {
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObjectW");

            JobExtendedLimitInformation limits = new JobExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 64;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JobExtendedLimitInformation))))
                throw LastError("SetInformationJobObject");

            IntPtr module = LoadSandboxModule();
            if (module == IntPtr.Zero) throw LastError("LoadLibraryExW(processmodel.dll)");
            IntPtr export = GetProcAddress(module, "Experimental_CreateProcessInSandbox");
            if (export == IntPtr.Zero) throw new NotSupportedException("Experimental_CreateProcessInSandbox is unavailable; refusing unsandboxed launch");
            CreateProcessInSandboxDelegate create = (CreateProcessInSandboxDelegate)Marshal.GetDelegateForFunctionPointer(export, typeof(CreateProcessInSandboxDelegate));

            string commandLine = Quote(executable);
            if (arguments != null)
            {
                for (int index = 0; index < arguments.Length; index++) commandLine += " " + Quote(arguments[index]);
            }
            StringBuilder mutableCommandLine = new StringBuilder(commandLine);
            StartupInfo startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
            environment = Marshal.StringToHGlobalUni(BuildEnvironment(workspace, pathValue, modulePathValue));

            bool launched = create(
                executable,
                mutableCommandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment,
                processCurrentDirectory,
                ref startup,
                identity,
                specification,
                (uint)specification.Length,
                out process);
            if (!launched) throw LastError("Experimental_CreateProcessInSandbox");
            created = true;

            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 0xC0000001);
                WaitForSingleObject(process.hProcess, 5000);
                throw new Win32Exception(error, "AssignProcessToJobObject failed; the suspended sandbox process was terminated");
            }
            assigned = true;

            File.WriteAllText(launchMarkerPath,
                "{\"processId\":" + process.dwProcessId + ",\"hostProcessId\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"identity\":\"" + identity + "\"}");

            uint previousSuspendCount = ResumeThread(process.hThread);
            if (previousSuspendCount == 0xFFFFFFFF) throw LastError("ResumeThread");

            uint wait = WaitForSingleObject(process.hProcess, (uint)timeoutMilliseconds);
            LsSandboxRunResult result = new LsSandboxRunResult();
            result.ProcessId = process.dwProcessId;
            result.ResumePreviousSuspendCount = previousSuspendCount;

            if (wait == WAIT_TIMEOUT)
            {
                result.TimedOut = true;
                result.RootWaitBeforeTermination = wait;
                uint rootExitCode;
                if (GetExitCodeProcess(process.hProcess, out rootExitCode)) result.RootExitCodeBeforeTermination = rootExitCode;
                if (!TerminateJobObject(job, 124)) throw LastError("TerminateJobObject(timeout)");
                result.TreeTerminated = WaitForSingleObject(process.hProcess, 5000) == WAIT_OBJECT_0
                    && WaitForSingleObject(job, 5000) == WAIT_OBJECT_0;
                result.ExitCode = 124;
                if (!result.TreeTerminated) throw new TimeoutException("The job still had active processes after TerminateJobObject");
            }
            else if (wait == WAIT_OBJECT_0)
            {
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw LastError("GetExitCodeProcess");
                result.ExitCode = unchecked((int)exitCode);
                // The experimental API may retain helper processes after the
                // requested image exits. End the job to ensure no descendants
                // or helpers outlive this command, then verify the whole job.
                if (!TerminateJobObject(job, exitCode)) throw LastError("TerminateJobObject(completion)");
                result.TreeTerminated = WaitForSingleObject(process.hProcess, 5000) == WAIT_OBJECT_0
                    && WaitForSingleObject(job, 5000) == WAIT_OBJECT_0;
                if (!result.TreeTerminated) throw new TimeoutException("The job still had active processes after command completion");
            }
            else
            {
                throw LastError("WaitForSingleObject(job)");
            }

            File.WriteAllText(resultPath,
                "{\"processId\":" + result.ProcessId + ",\"exitCode\":" + result.ExitCode + ",\"timedOut\":" + result.TimedOut.ToString().ToLowerInvariant() + ",\"treeTerminated\":" + result.TreeTerminated.ToString().ToLowerInvariant() + ",\"resumePreviousSuspendCount\":" + result.ResumePreviousSuspendCount + ",\"rootWaitBeforeTermination\":" + result.RootWaitBeforeTermination + ",\"rootExitCodeBeforeTermination\":" + result.RootExitCodeBeforeTermination + "}");
            return result;
        }
        finally
        {
            if (created && !assigned && process.hProcess != IntPtr.Zero)
            {
                TerminateProcess(process.hProcess, 0xC0000001);
                WaitForSingleObject(process.hProcess, 5000);
            }
            if (job != IntPtr.Zero) CloseHandle(job); // KILL_ON_JOB_CLOSE is the crash/cancel backstop.
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (pinnedWorkspace != IntPtr.Zero) CloseHandle(pinnedWorkspace);
        }
    }

    private static IntPtr LoadSandboxModule()
    {
        string systemPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "processmodel.dll");
        return LoadLibraryExW(systemPath, IntPtr.Zero, LOAD_LIBRARY_SEARCH_SYSTEM32);
    }

    private static IntPtr OpenPinnedDirectory(string path)
    {
        IntPtr handle = CreateFileW(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE, // Deliberately omit FILE_SHARE_DELETE to pin this directory entry.
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw LastError("CreateFileW(workspace pin)");

        FileAttributeTagInformation information;
        if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out information, (uint)Marshal.SizeOf(typeof(FileAttributeTagInformation))))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(handle);
            throw new Win32Exception(error, "GetFileInformationByHandleEx(workspace)");
        }
        if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            CloseHandle(handle);
            throw new IOException("Workspace root is a reparse point; refusing sandbox launch");
        }
        return handle;
    }

    private static string BuildEnvironment(string workspace, string pathValue, string modulePathValue)
    {
        string profile = Path.Combine(workspace, "profile");
        string temporary = Path.Combine(workspace, "temp");
        Directory.CreateDirectory(profile);
        Directory.CreateDirectory(Path.Combine(profile, "AppData", "Roaming"));
        Directory.CreateDirectory(Path.Combine(profile, "AppData", "Local"));
        Directory.CreateDirectory(temporary);
        string drive = Path.GetPathRoot(workspace).TrimEnd(Path.DirectorySeparatorChar);
        string homePath = workspace.Substring(drive.Length);

        SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        values["APPDATA"] = Path.Combine(profile, "AppData", "Roaming");
        values["COMSPEC"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        values["GIT_CONFIG_NOSYSTEM"] = "1";
        values["GIT_TRACE2_EVENT"] = Path.Combine(workspace, "git-trace2.json");
        values["HOME"] = profile;
        values["HOMEDRIVE"] = drive;
        values["HOMEPATH"] = profile.Substring(drive.Length);
        values["LOCALAPPDATA"] = Path.Combine(profile, "AppData", "Local");
        values["PATH"] = pathValue;
        values["PATHEXT"] = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC";
        values["PSModulePath"] = modulePathValue;
        values["SYSTEMROOT"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        values["TEMP"] = temporary;
        values["TMP"] = temporary;
        values["USERPROFILE"] = profile;
        values["WINDIR"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows);

        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in values)
        {
            block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        }
        block.Append('\0');
        return block.ToString();
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2).Append('"');
        return quoted.ToString();
    }

    private static Win32Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
}
