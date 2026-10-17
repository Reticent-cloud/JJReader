using Xunit;

namespace JingjingReader.Tests;

/// <summary>
/// C1（关联收尾）：有效默认程序 = UserChoice 优先、Classes 默认回退。
/// 安装决策 / GetState / 卸载警告都读同一个 Resolve。
/// </summary>
public class EffectiveAssociationTests
{
    private static FakeRegistry NewRegistry() => new();

    [Fact]
    public void UserChoice_wins_over_classes_default()
    {
        var registry = NewRegistry();
        registry.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", "Typora.md");

        Assert.Equal("Typora.md", EffectiveAssociation.Resolve(registry));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Falls_back_to_classes_default_when_user_choice_missing_or_blank(string? userChoice)
    {
        var registry = NewRegistry();
        registry.SetValue(Assoc.DotMdKey(), null, "WorkBuddy.md");
        if (userChoice is not null)
        {
            registry.SetValue(Assoc.UserChoiceKey(), "ProgId", userChoice);
        }

        Assert.Equal("WorkBuddy.md", EffectiveAssociation.Resolve(registry));
    }

    [Fact]
    public void Returns_null_when_no_association_exists()
    {
        Assert.Null(EffectiveAssociation.Resolve(NewRegistry()));
    }

    [Fact]
    public void IsJingjingReaderDefault_true_only_for_effective_progid()
    {
        var registry = NewRegistry();
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", Assoc.ProgId);
        Assert.True(EffectiveAssociation.IsJingjingReaderDefault(registry));

        // 大小写不敏感
        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", "jingjingreader.md");
        Assert.True(EffectiveAssociation.IsJingjingReaderDefault(registry));

        registry.SetValue(Assoc.UserChoiceKey(), "ProgId", "Other.md");
        Assert.False(EffectiveAssociation.IsJingjingReaderDefault(registry));
    }

    [Fact]
    public void IsJingjingReaderDefault_falls_back_to_classes_when_userchoice_absent()
    {
        var registry = NewRegistry();
        registry.SetValue(Assoc.DotMdKey(), null, Assoc.ProgId);

        Assert.True(EffectiveAssociation.IsJingjingReaderDefault(registry));
    }

    [Fact]
    public void Null_registry_is_rejected()
    {
        Assert.Throws<ArgumentNullException>(() => EffectiveAssociation.Resolve(null!));
        Assert.Throws<ArgumentNullException>(() => EffectiveAssociation.IsJingjingReaderDefault(null!));
    }
}
