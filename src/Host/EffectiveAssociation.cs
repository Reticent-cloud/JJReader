namespace JingjingReader;

/// <summary>
/// 计算「.md 的有效默认程序」（C1 关联收尾）：Windows 10/11 用户显式选择默认程序后，
/// 真正生效的是 <c>FileExts\.md\UserChoice\ProgId</c>；<c>Software\Classes\.md</c> 的默认值只是
/// 没有 UserChoice 时的回退。安装决策、GetState 与卸载警告都必须读同一个「有效默认」，
/// 否则会在 UserChoice 指向别的程序时仍把自己的 Classes 默认值当成默认（误报 + 误写）。
/// 纯函数（只经 <see cref="IAssocRegistry"/> 读），便于单测。
/// </summary>
public static class EffectiveAssociation
{
    /// <summary>UserChoice 的 ProgId 值名（默认值不是 ProgId，不能读 null）。</summary>
    public const string UserChoiceProgIdValueName = "ProgId";

    /// <summary>
    /// 有效默认 ProgID：UserChoice 非空白时优先；否则回退 <c>Software\Classes\.md</c> 默认值。
    /// 两者都没有时返回 null（表示 .md 没有关联任何程序）。
    /// </summary>
    public static string? Resolve(IAssocRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(registry);

        var userChoice = registry.GetValue(Assoc.UserChoiceKey(), UserChoiceProgIdValueName);
        if (!string.IsNullOrWhiteSpace(userChoice))
        {
            return userChoice;
        }

        return registry.GetValue(Assoc.DotMdKey(), null);
    }

    /// <summary>有效默认程序是否就是本程序（大小写不敏感；空值不算）。</summary>
    public static bool IsJingjingReaderDefault(IAssocRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(registry);

        var effective = Resolve(registry);
        return !string.IsNullOrWhiteSpace(effective)
            && string.Equals(effective, Assoc.ProgId, StringComparison.OrdinalIgnoreCase);
    }
}
