/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Recorded parser outputs and principals; extracted production document and
// container inheritance are exercised independently of browser/IPC integration.
#include <algorithm>
#include <cassert>
#include <functional>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

static unsigned checks = 0;
#define CHECK(value) do { ++checks; if (!(value)) { std::cerr << __LINE__ << ": " << #value << '\n'; std::abort(); } } while (false)
#define MOZ_ASSERT(value) assert(value)
#define MOZ_CRASH(value) std::abort()
using nsAString = std::string;
struct nsString : std::string {
  using std::string::string;
  using std::string::operator=;
  bool IsEmpty() const { return empty(); }
  nsString(const std::string& text) : std::string(text) {}
  bool Equals(const std::string& text) const { return *this == text; }
  void AppendASCII(const char* text) { append(text); }
};
static nsString operator""_ns(const char* text, size_t size) { return nsString(text, size); }
template<class T> class RefPtr {
  std::shared_ptr<T> value;
 public:
  RefPtr() = default;
  RefPtr(std::nullptr_t) {}
  RefPtr(T* raw) {
    if (raw) { value = raw->weak_from_this().lock(); if (!value) value.reset(raw); }
  }
  RefPtr(std::shared_ptr<T> raw) : value(std::move(raw)) {}
  T* get() const { return value.get(); }
  T* operator->() const { return get(); }
  operator T*() const { return get(); }
};
template<class T> using nsCOMPtr = RefPtr<T>;
template<class T> static RefPtr<T>& getter_AddRefs(RefPtr<T>& value) { return value; }
template<class T> struct nsTArray : std::vector<T> {
  nsTArray Clone() const { return *this; }
  void Clear() { this->clear(); }
  bool IsEmpty() const { return this->empty(); }
  void AppendElement(T value) { this->push_back(std::move(value)); }
  T PopLastElement() { auto value = std::move(this->back()); this->pop_back(); return value; }
  bool Contains(const T& value) const { return std::find(this->begin(), this->end(), value) != this->end(); }
};
template<class T, size_t N> using AutoTArray = nsTArray<T>;
template<class T> using Maybe = std::optional<T>;
struct nsIPrincipal : std::enable_shared_from_this<nsIPrincipal> {
  std::string origin;
  bool content = true;
  explicit nsIPrincipal(std::string value) : origin(std::move(value)) {}
  bool GetIsContentPrincipal() const { return content; }
  bool Equals(const nsIPrincipal* other) const { return other && origin == other->origin; }
  bool Subsumes(const nsIPrincipal* other, int) const { return Equals(other); }
};
struct BasePrincipal {
  static constexpr int ConsiderDocumentDomain = 0;
  static nsIPrincipal* Cast(nsIPrincipal* value) { return value; }
};
struct Feature {
  nsString name = "payment";
  bool all = false;
  std::vector<nsCOMPtr<nsIPrincipal>> allow;
  const nsString& Name() const { return name; }
  bool AllowsAll() const { return all; }
  bool Allows(nsIPrincipal* principal) const {
    return all || std::any_of(allow.begin(), allow.end(), [&](auto& p) { return p->Equals(principal); });
  }
};
struct FeaturePolicyInfo {
  nsTArray<nsString> mInheritedDeniedFeatureNames, mAttributeEnabledFeatureNames;
  nsString mDeclaredString;
  nsCOMPtr<nsIPrincipal> mDefaultOrigin, mSelfOrigin, mSrcOrigin;
  nsTArray<nsString> mParentInheritedDeniedFeatureNames;
  nsString mParentDeclaredString;
  nsCOMPtr<nsIPrincipal> mParentOrigin;
};
struct FeaturePolicy;
struct FeaturePolicyUtils {
  enum FeaturePolicyValue { eAll, eSelf, eNone };
  static bool IsSupportedFeature(const nsAString& name) { return name == "payment" || name == "default-all" || name == "default-none"; }
  static void ForEachFeature(const std::function<void(const char*)>& fn) { fn("payment"); fn("default-all"); fn("default-none"); }
  static FeaturePolicyValue DefaultAllowListFeature(const nsAString& name) { return name == "default-all" ? eAll : name == "default-none" ? eNone : eSelf; }
};
struct FeaturePolicy : std::enable_shared_from_this<FeaturePolicy> {
  nsCOMPtr<nsIPrincipal> mDefaultOrigin, mSelfOrigin, mSrcOrigin, mParentOrigin;
  nsString mDeclaredString, mParentDeclaredString;
  nsTArray<Feature> mFeatures, mDeclaredFeaturesInAncestorChain;
  nsTArray<nsString> mInheritedDeniedFeatureNames, mParentAllowedAllFeatures;
  nsTArray<nsString> mAttributeEnabledFeatureNames, mParentInheritedDeniedFeatureNames;
  explicit FeaturePolicy(std::nullptr_t) {}
  void SetDefaultOrigin(nsIPrincipal* value) { mDefaultOrigin = value; }
  void AppendToDeclaredAllowInAncestorChain(const Feature&) {}
  void SetInheritedDeniedFeatureNames(const nsTArray<nsString>& value) { mInheritedDeniedFeatureNames = value.Clone(); }
  // These names select recorded parser outputs, not actual Web syntax.
  void Record(const nsAString& text, nsIPrincipal* self, nsIPrincipal* src) {
    mFeatures.clear();
    if (text.empty()) return;
    Feature f;
    if (text == "all") f.all = true;
    else if (text == "self") f.allow.emplace_back(self);
    else if (text == "src") f.allow.emplace_back(src);
    else if (text == "final") f.allow.emplace_back(std::make_shared<nsIPrincipal>("https://c.invalid"));
    else if (text == "self-src" || text == "self-final") {
      f.allow.emplace_back(self);
      f.allow.emplace_back(std::make_shared<nsIPrincipal>(text == "self-src" ? "https://b.invalid" : "https://c.invalid"));
    } else CHECK(text == "deny");
    mFeatures.push_back(f);
  }
  void SetDeclaredPolicy(void*, const nsAString& text, nsIPrincipal* self, nsIPrincipal* src) {
    CHECK(!text.starts_with("header:"));
    mDeclaredString = text; mSelfOrigin = self; mSrcOrigin = src;
    Record(text,self,src);
  }
  void SetDeclaredPolicyFromPermissionsPolicyHeader(void*, const nsAString& text, nsIPrincipal* self) {
    CHECK(text.empty() || text.starts_with("header:"));
    mDeclaredString = text; mSelfOrigin = self;
    Record(text.empty() ? text : text.substr(7),self,nullptr);
  }
  void MaybeSetAllowedPolicy(const nsAString& name) {
    if (!HasDeclaredFeature(name)) { Feature f; f.name = name; f.all = true; mFeatures.push_back(f); mAttributeEnabledFeatureNames.AppendElement(nsString(name)); }
  }
  void InheritPolicy(FeaturePolicy*);
  void InheritPolicy(const FeaturePolicyInfo&);
  void SetInheritedDeniedFeature(const nsAString&);
  bool HasInheritedDeniedFeature(const nsAString&) const;
  bool HasDeclaredFeature(const nsAString&) const;
  bool HasFeatureUnsafeAllowsAll(const nsAString&) const;
  bool AllowsFeatureInternal(const nsAString&, nsIPrincipal*) const;
  FeaturePolicyInfo ToFeaturePolicyInfo() const;
};
namespace dom { using ::FeaturePolicy; }
static std::string NS_ConvertUTF16toUTF8(const nsAString& text) { return text; }

// PRODUCTION_METHODS

static RefPtr<nsIPrincipal> origin(const char* host) {
  return std::make_shared<nsIPrincipal>(std::string("https://") + host + ".invalid");
}

static FeaturePolicyInfo snapshot(const char* header, const char* allow,
                                  nsIPrincipal* source, bool parentDenied = false,
                                  bool legacyAttribute = false) {
  auto a = origin("a");
  RefPtr<FeaturePolicy> parent = new FeaturePolicy(nullptr);
  parent->SetDefaultOrigin(a);
  parent->SetDeclaredPolicyFromPermissionsPolicyHeader(nullptr, header, a);
  if (parentDenied) parent->SetInheritedDeniedFeature("payment");
  RefPtr<FeaturePolicy> container = new FeaturePolicy(nullptr);
  container->SetDefaultOrigin(source);
  container->SetDeclaredPolicy(nullptr, allow, a, source);
  if (legacyAttribute) container->MaybeSetAllowedPolicy("payment");
  container->InheritPolicy(parent);
  return container->ToFeaturePolicyInfo();
}

static bool loaded(const FeaturePolicyInfo& info, nsIPrincipal* target,
                   const char* ownHeader = "") {
  RefPtr<FeaturePolicy> doc = new FeaturePolicy(nullptr);
  doc->SetDefaultOrigin(target);
  doc->InheritPolicy(info);
  doc->SetDeclaredPolicyFromPermissionsPolicyHeader(nullptr, ownHeader, target);
  return doc->AllowsFeatureInternal("payment", target);
}

int main() {
  const auto a = origin("a"), b = origin("b"), c = origin("c");
  // A container's explicit wildcard survives a cross-origin redirect.
  // R33 rejects this because the document is treated as another iframe.
  CHECK(loaded(snapshot("header:all", "all", a), b));
  CHECK(loaded(snapshot("header:all", "all", b), a));
  CHECK(loaded(snapshot("header:all", "all", b), c));
  CHECK(!loaded(snapshot("header:all", "src", a), b));
  CHECK(!loaded(snapshot("header:all", "src", b), a));
  CHECK(!loaded(snapshot("header:all", "src", b), c));
  CHECK(loaded(snapshot("header:all", "src", b), b));
  CHECK(loaded(snapshot("", "src", b), b));
  CHECK(!loaded(snapshot("header:self", "all", b), b));

  // Recompute parent and container decisions for the final origin. A flattened
  // denial for the original src must neither reject a valid destination nor
  // lose a parent header restriction after a permitted first hop.
  CHECK(loaded(snapshot("header:self-final", "all", b), c));
  CHECK(!loaded(snapshot("header:self-src", "all", b), c));
  CHECK(!loaded(snapshot("header:final", "all", b), c));
  CHECK(loaded(snapshot("header:all", "final", b), c));
  CHECK(!loaded(snapshot("header:all", "final", b), b));
  CHECK(loaded(snapshot("header:all", "self", b), a));
  CHECK(!loaded(snapshot("header:all", "self", b), b));
  CHECK(loaded(snapshot("header:all", "", b), a));
  CHECK(!loaded(snapshot("header:all", "", a), b));
  CHECK(!loaded(snapshot("", "", a), b));
  CHECK(loaded(snapshot("", "", b), a));
  CHECK(!loaded(snapshot("header:deny", "all", a), a));
  CHECK(!loaded(snapshot("header:all", "deny", a), a));
  CHECK(!loaded(snapshot("header:all", "all", b, true), c));
  CHECK(!loaded(snapshot("header:all", "all", a), b, "header:deny"));
  CHECK(loaded(snapshot("header:all", "", b, false, true), c));

  auto info = snapshot("header:all", "all", b);
  // Child-computed deny lists for a prospective src are not used as the
  // embedding document's authoritative inherited state.
  info.mInheritedDeniedFeatureNames.AppendElement("payment");
  CHECK(loaded(info, c));
  info.mParentInheritedDeniedFeatureNames.AppendElement("payment");
  CHECK(!loaded(info, c));
  info.mParentInheritedDeniedFeatureNames.Clear();
  info.mParentOrigin = nullptr;
  CHECK(!loaded(info, c));
  info = snapshot("header:all", "all", b);
  info.mSelfOrigin = c;
  CHECK(!loaded(info, c));

  // Replacing inherited policy on the same live document clears the previous
  // denial, but must not erase the document's own HTTP declaration.
  RefPtr<FeaturePolicy> doc = new FeaturePolicy(nullptr);
  doc->SetDefaultOrigin(c);
  doc->InheritPolicy(snapshot("header:deny", "all", a));
  CHECK(!doc->AllowsFeatureInternal("payment", c));
  doc->InheritPolicy(snapshot("header:all", "all", a));
  CHECK(doc->AllowsFeatureInternal("payment", c));
  doc->SetDeclaredPolicyFromPermissionsPolicyHeader(nullptr, "header:deny", c);
  doc->InheritPolicy(snapshot("header:all", "all", a));
  CHECK(!doc->AllowsFeatureInternal("payment", c));
  doc->InheritPolicy(snapshot("header:all", "all", a));
  CHECK(doc->AllowsFeatureInternal("default-all", c));
  CHECK(!doc->AllowsFeatureInternal("default-none", c));
  auto invalid = snapshot("header:all", "all", a);
  invalid.mParentOrigin = nullptr;
  doc->InheritPolicy(invalid);
  CHECK(!doc->AllowsFeatureInternal("default-all", c));
  auto deniedAll = snapshot("header:all", "all", a);
  deniedAll.mParentInheritedDeniedFeatureNames.AppendElement("default-all");
  doc->InheritPolicy(deniedAll);
  CHECK(!doc->AllowsFeatureInternal("default-all", c));
  std::cout << "document/container inheritance checks passed: " << checks << '\n';
}
