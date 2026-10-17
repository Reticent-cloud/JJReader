using System.IO;
using System.Text;

namespace JingjingReader;

/// <summary>
/// 一次文档读取的结果。编码名约定：<c>utf-8</c> / <c>utf-16le</c> / <c>utf-16be</c> / <c>gb18030</c>；
/// 检测到二进制（含 NUL 字节）时为 <c>binary</c>，此时 <see cref="Text"/> 为空字符串，由调用方决定拒绝渲染。
/// </summary>
public sealed record DocumentRead(
    string Path,
    string Text,
    string EncodingName,
    bool HadBom,
    long Size,
    DateTime LastWriteUtc,
    string Key);

/// <summary>
/// 宿主侧文件能力：路径规范化、扩展名判断、编码探测、文档读取、虚拟主机 URL 转换、相对资源解析（含目录穿越防护）。
/// </summary>
public static class FileHost
{
    /// <summary>WebView2 虚拟主机名对应的 URL 前缀（spec §4.5：SetVirtualHostNameToFolderMapping("md.local", 文档目录)）。</summary>
    private const string VirtualHostPrefix = "https://md.local/";

    /// <summary>超过该长度的路径改用 \\?\ 扩展形式（经典 Win32 MAX_PATH 上限为 260）。</summary>
    private const int LongPathThreshold = 255;

    private const string ExtendedPrefix = @"\\?\";
    private const string ExtendedUncPrefix = @"\\?\UNC\";
    private const string DevicePrefix = @"\\.\";

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    private static readonly UTF8Encoding LooseUtf8 = new(encoderShouldEmitUTF8Identifier: false);
    private static readonly Encoding Utf16Le = new UnicodeEncoding(bigEndian: false, byteOrderMark: false);
    private static readonly Encoding Utf16Be = new UnicodeEncoding(bigEndian: true, byteOrderMark: false);
    private static readonly Encoding Gb18030;

    /// <summary>
    /// 注册 CodePages provider：GB18030 不在 .NET 默认编码表里，不注册就取不到（System.Text.Encoding.CodePages
    /// 已随 .NET 10 共享运行库分发，无需额外 NuGet 包）。显式静态构造函数保证首次使用任何成员之前完成注册。
    /// </summary>
    static FileHost()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        Gb18030 = Encoding.GetEncoding("GB18030");
    }

    /// <summary>
    /// 规范化路径：去首尾空白与成对引号 → 相对路径按当前工作目录转绝对 → 统一 <c>\</c> → 盘符大写。
    /// 长度超过 255 的路径加 <c>\\?\</c> 前缀；UNC 路径加等价的 <c>\\?\UNC\</c> 前缀（幂等）。
    /// 除盘符外不改写大小写。
    /// </summary>
    public static string NormalizePath(string input)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(input);

        var trimmed = input.Trim().Trim('"').Trim();
        if (trimmed.Length == 0)
        {
            throw new ArgumentException("路径不能为空。", nameof(input));
        }

        var full = Path.GetFullPath(trimmed).Replace('/', '\\');
        if (IsExtendedOrDevicePath(full))
        {
            return UppercaseDriveLetter(full, devicePath: true);
        }

        full = UppercaseDriveLetter(full, devicePath: false);

        if (full.StartsWith(@"\\", StringComparison.Ordinal))
        {
            // \\server\share\... 的扩展形式是 \\?\UNC\server\share\...（不能写成 \\?\\\server…）
            return ExtendedUncPrefix + full[2..];
        }

        return full.Length > LongPathThreshold ? ExtendedPrefix + full : full;
    }

    /// <summary>单文件打开上限（M11：超过 50 MB 直接拒绝，避免同步读取把宿主卡死）。</summary>
    public const long MaxDocumentBytes = 50L * 1024 * 1024;

    /// <summary>文件是否超过 <see cref="MaxDocumentBytes"/>（严格大于；等于 50 MB 仍允许）。</summary>
    public static bool IsTooLarge(long size) => size > MaxDocumentBytes;

    /// <summary>可渲染的 Markdown 文本扩展名：<c>.md</c>、<c>.markdown</c>、<c>.mdown</c>、<c>.txt</c>（大小写不敏感）。</summary>
    public static bool IsMarkdown(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

        var extension = Path.GetExtension(path);
        return extension.Equals(".md", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".markdown", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".mdown", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".txt", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 编码探测：BOM（UTF-8 / UTF-16LE / UTF-16BE）→ 含 NUL 判二进制 → 严格 UTF-8 → GB18030 → 兜底 UTF-8（替换字符）。
    /// BOM 优先于 NUL 判断，否则 UTF-16 文本会被误判为二进制。
    /// </summary>
    public static (string Text, string EncodingName, bool HadBom, bool IsBinary) Decode(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);

        if (HasPrefix(bytes, 0xEF, 0xBB, 0xBF))
        {
            return (LooseUtf8.GetString(bytes, 3, bytes.Length - 3), "utf-8", true, false);
        }

        if (HasPrefix(bytes, 0xFF, 0xFE))
        {
            return (Utf16Le.GetString(bytes, 2, bytes.Length - 2), "utf-16le", true, false);
        }

        if (HasPrefix(bytes, 0xFE, 0xFF))
        {
            return (Utf16Be.GetString(bytes, 2, bytes.Length - 2), "utf-16be", true, false);
        }

        if (Array.IndexOf(bytes, (byte)0) >= 0)
        {
            return (string.Empty, "binary", false, true);
        }

        try
        {
            return (StrictUtf8.GetString(bytes), "utf-8", false, false);
        }
        catch (DecoderFallbackException)
        {
            // 不是合法 UTF-8，继续按中文环境最常见的 GB18030 尝试
        }

        try
        {
            return (Gb18030.GetString(bytes), "gb18030", false, false);
        }
        catch (Exception e) when (e is DecoderFallbackException or ArgumentException)
        {
            // 兜底：UTF-8 替换字符；调用方据 encoding 提示「编码可能有问题」
            return (LooseUtf8.GetString(bytes), "utf-8", false, false);
        }
    }

    /// <summary>
    /// 读取整个文档：字节 → <see cref="Decode"/> → <c>Key = sha1(规范化路径|大小|修改时间 UTC)</c>。
    /// 文件不存在 / 无权限时抛标准异常（<see cref="FileNotFoundException"/>、<see cref="UnauthorizedAccessException"/>）。
    /// 二进制内容不抛异常，原样返回（<c>EncodingName == "binary"</c>）。
    /// </summary>
    public static DocumentRead ReadDocument(string filePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);

        var path = NormalizePath(filePath);
        var bytes = File.ReadAllBytes(path);
        var (text, encodingName, hadBom, _) = Decode(bytes);
        var lastWriteUtc = File.GetLastWriteTimeUtc(path);
        var key = Store.ComputeKey(path, bytes.Length, lastWriteUtc);

        return new DocumentRead(path, text, encodingName, hadBom, bytes.Length, lastWriteUtc, key);
    }

    /// <summary>
    /// 把文档内的相对（或绝对）引用转换为虚拟主机 URL：以文档所在目录为根，逐段 <see cref="Uri.EscapeDataString(string)"/>
    /// 并保留 <c>/</c>。null / 空白 / "." 返回 <c>https://md.local/</c>。
    /// 引用中的百分号编码（如 <c>img/a%20b.png</c>）先按 CommonMark 语义解码一次再参与路径计算与逐段转义，
    /// 否则会被二次编码成 <c>img/a%2520b.png</c>。解码失败（非法转义）保持原样，不抛异常。
    /// 越出文档目录（含 <c>..</c>、跨盘绝对路径）时不抛异常，返回 <c>https://md.local/</c> + 同样先解码再逐段转义的原始引用，交给调用方占位兜底。
    /// </summary>
    public static string VirtualHostUrl(string docPath, string? relativeOrAbsolutePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(docPath);

        if (string.IsNullOrWhiteSpace(relativeOrAbsolutePath))
        {
            return VirtualHostPrefix;
        }

        // 仅引用需要解码（文档路径是宿主传入的本地路径，不含 URL 编码语义）
        var reference = UnescapeReference(relativeOrAbsolutePath);

        try
        {
            var docFull = Path.GetFullPath(StripExtendedPrefix(docPath));
            var docDir = Path.GetDirectoryName(docFull);
            if (string.IsNullOrEmpty(docDir))
            {
                docDir = Path.GetPathRoot(docFull);
            }

            if (string.IsNullOrEmpty(docDir))
            {
                return VirtualHostPrefix + EscapeSegments(reference);
            }

            var full = Path.GetFullPath(Path.Combine(docDir, StripExtendedPrefix(reference)));
            var relativePath = Path.GetRelativePath(docDir, full);

            if (relativePath == ".")
            {
                return VirtualHostPrefix;
            }

            if (EscapesDirectory(relativePath))
            {
                return VirtualHostPrefix + EscapeSegments(reference);
            }

            return VirtualHostPrefix + EscapeSegments(relativePath);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            // 引用本身不是合法路径：按原始引用兜底，绝不因为一张图片的路径而中断渲染
            return VirtualHostPrefix + EscapeSegments(reference);
        }
    }

    /// <summary>
    /// 解码引用里的百分号编码（CommonMark 中 <c>![x](img/a%20b.png)</c> 指向文件名含空格的图片）。
    /// 非法转义序列（如 <c>100%.png</c>、<c>a%zz.png</c>）保持原样；万一运行时抛异常也回退原字符串，绝不中断渲染。
    /// </summary>
    private static string UnescapeReference(string reference)
    {
        try
        {
            return Uri.UnescapeDataString(reference);
        }
        catch (Exception e) when (e is UriFormatException or ArgumentException)
        {
            return reference;
        }
    }

    /// <summary>
    /// 把引用落到 <paramref name="docDir"/> 内的绝对路径：绝对路径与相对路径走同一套校验，
    /// 规范化后必须严格位于目录内（<c>docDir + \</c> 前缀，大小写不敏感），越界 / 空白 / 非法路径返回 null。
    /// </summary>
    public static string? ResolveInside(string docDir, string reference)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(docDir);

        if (string.IsNullOrWhiteSpace(reference))
        {
            return null;
        }

        try
        {
            var dirFull = Path.GetFullPath(StripExtendedPrefix(docDir));
            var referenceFull = Path.GetFullPath(Path.Combine(dirFull, StripExtendedPrefix(reference)));
            var prefix = dirFull.EndsWith('\\') ? dirFull : dirFull + "\\";

            return referenceFull.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? referenceFull : null;
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
    }

    /// <summary>去掉 <c>\\?\</c> / <c>\\?\UNC\</c> / <c>\\.\</c> 扩展前缀：普通绝对路径才能让 Path API 正常折叠 <c>..</c>。</summary>
    private static string StripExtendedPrefix(string path)
    {
        if (path.StartsWith(ExtendedUncPrefix, StringComparison.Ordinal))
        {
            return @"\\" + path[ExtendedUncPrefix.Length..];
        }

        if (path.StartsWith(ExtendedPrefix, StringComparison.Ordinal))
        {
            return path[ExtendedPrefix.Length..];
        }

        return path.StartsWith(DevicePrefix, StringComparison.Ordinal)
            ? path[DevicePrefix.Length..]
            : path;
    }

    private static bool IsExtendedOrDevicePath(string path)
        => path.StartsWith(ExtendedPrefix, StringComparison.Ordinal)
            || path.StartsWith(DevicePrefix, StringComparison.Ordinal);

    /// <summary>盘符统一大写（<c>c:\notes</c> → <c>C:\notes</c>）；除盘符外不改写大小写。</summary>
    private static string UppercaseDriveLetter(string path, bool devicePath)
    {
        var offset = devicePath ? ExtendedPrefix.Length : 0;
        var driveIndex = offset;
        if (path.Length > driveIndex + 1
            && path[driveIndex + 1] == ':'
            && char.IsAsciiLetterLower(path[driveIndex]))
        {
            return path[..driveIndex] + char.ToUpperInvariant(path[driveIndex]) + path[(driveIndex + 1)..];
        }

        return path;
    }

    /// <summary>GetRelativePath 的结果是否越出根目录：以 <c>..</c> 开头或本身是绝对路径（跨盘）。</summary>
    private static bool EscapesDirectory(string relativePath)
        => relativePath == ".."
            || relativePath.StartsWith(@"..\", StringComparison.Ordinal)
            || Path.IsPathFullyQualified(relativePath);

    /// <summary>逐段 URL 转义，保留 <c>/</c> 分隔符（中文、空格、<c>#</c>、<c>%</c> 都会被转义）。</summary>
    private static string EscapeSegments(string path)
    {
        var segments = path.Replace('\\', '/').Split('/');
        for (var i = 0; i < segments.Length; i++)
        {
            segments[i] = Uri.EscapeDataString(segments[i]);
        }

        return string.Join('/', segments);
    }

    private static bool HasPrefix(byte[] bytes, params byte[] prefix)
    {
        if (bytes.Length < prefix.Length)
        {
            return false;
        }

        for (var i = 0; i < prefix.Length; i++)
        {
            if (bytes[i] != prefix[i])
            {
                return false;
            }
        }

        return true;
    }
}
