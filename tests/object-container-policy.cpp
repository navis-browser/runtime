// SPDX-License-Identifier: MPL-2.0
// Actual document-load arm and publication methods; recorded channel/policy peers.
#include <cstdint>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

unsigned checks = 0;
#define CHECK(value) do { ++checks; if (!(value)) throw std::runtime_error(#value); } while (0)
#define MOZ_ASSERT(value, ...) CHECK(value)
#define MOZ_DIAGNOSTIC_ASSERT(value) CHECK(value)
#define NS_ASSERTION(value, ...) CHECK(value)
#define MOZ_ASSERT_UNREACHABLE(...) do {} while (0)
#define NS_WARN_IF(value) (value)
using nsresult = int;
using nsLoadFlags = unsigned;
constexpr nsresult NS_OK = 0, NS_ERROR_FAILURE = 1;
constexpr int LOAD_NORMAL = 0;
bool NS_FAILED(nsresult value) { return value != NS_OK; }
template<class T> struct Ptr {
  T* value = nullptr;
  Ptr() = default;
  Ptr(T* p) : value(p) {}
  Ptr(const Ptr&) = default;
  Ptr(Ptr&& p) : value(std::exchange(p.value, nullptr)) {}
  Ptr& operator=(const Ptr&) = default;
  Ptr& operator=(T* p) { value = p; return *this; }
  T* operator->() const { return value; }
  operator T*() const { return value; }
};
template<class T> using RefPtr = Ptr<T>;
template<class T> using nsCOMPtr = Ptr<T>;
template<class T> T** getter_AddRefs(Ptr<T>& p) { return &p.value; }
template<class T> std::optional<T> Some(T value) { return value; }
struct nsIPrincipal { unsigned identity = 7; };
struct nsIURI {};
struct FeaturePolicyInfo { unsigned origin; unsigned parent; };
struct Element;
struct FeaturePolicy {
  Element* node = nullptr;
  unsigned origin = 0, parent = 0;
  void SetDefaultOrigin(nsIPrincipal* value) { origin = value->identity; }
  void InheritPolicy(FeaturePolicy* value) { parent = value->origin; }
  FeaturePolicyInfo ToFeaturePolicyInfo() { return {origin, parent}; }
};
template<class T> T* MakeAndAddRef(Element* node) {
  static T value;
  value = T(); value.node = node; return &value;
}
struct Document {
  ::FeaturePolicy policy;
  ::FeaturePolicy* FeaturePolicy() { return &policy; }
};
struct Element {
  Document document;
  nsIPrincipal origin;
  bool composed = true;
  Document* OwnerDoc() { return &document; }
  bool IsInComposedDoc() { return composed; }
  static Element* FromNode(Element* value) { return value; }
};
using nsGenericHTMLElement = Element;
struct BrowsingContext {
  bool subframe = true;
  bool IsContentSubframe() { return subframe; }
};
struct nsFrameLoader {
  bool remote = false, existingDocShell = true, destroyed = false;
  BrowsingContext* context = nullptr;
  bool IsRemoteFrame() { return remote; }
  bool GetExistingDocShell() { return existingDocShell; }
  BrowsingContext* GetBrowsingContext() { return context; }
  void Destroy() { destroyed = true; }
};
struct nsIInterfaceRequestor {};
struct nsIDocShell : nsIInterfaceRequestor {
  BrowsingContext* context = nullptr;
  BrowsingContext* GetBrowsingContext() { return context; }
};
nsIInterfaceRequestor* do_QueryInterface(nsIDocShell* value) { return value; }
struct nsIChannel {
  static constexpr unsigned LOAD_DOCUMENT_URI = 1;
  nsLoadFlags flags = 8;
  void GetLoadFlags(nsLoadFlags* value) { *value = flags; }
  void SetLoadFlags(nsLoadFlags value) { flags = value; }
};
std::vector<std::string> order;
struct ContentChild {
  static inline ContentChild* instance = nullptr;
  unsigned sent = 0;
  BrowsingContext* context = nullptr;
  std::optional<FeaturePolicyInfo> info;
  static ContentChild* GetSingleton() { return instance; }
  bool SendSetContainerFeaturePolicy(BrowsingContext* bc,
                                     std::optional<FeaturePolicyInfo> policy) {
    ++sent; context = bc; info = policy;
    order.push_back("policy"); return true;
  }
};
struct nsIStreamListener { void OnStartRequest(nsIChannel*) { order.push_back("start"); } };
struct nsIURILoader {
  nsIStreamListener listener;
  bool hadPolicyAtOpen = false;
  nsresult result = NS_OK;
  nsresult OpenChannel(nsIChannel*, unsigned flags, nsIInterfaceRequestor* request,
                       nsIStreamListener** output) {
    CHECK(flags == 16 && request);
    hadPolicyAtOpen = ContentChild::instance && ContentChild::instance->info.has_value();
    order.push_back("open");
    if (result == NS_OK) *output = &listener;
    return result;
  }
};
namespace components {
struct URILoader { static inline nsIURILoader* value; static nsIURILoader* Service() { return value; } };
}
struct nsDocShell {
  static unsigned ComputeURILoaderFlags(BrowsingContext*, int type, bool document) {
    CHECK(type == LOAD_NORMAL && !document); return 16;
  }
};
enum class ObjectType { Document, Loading, Fallback };
class nsObjectLoadingContent {
 public:
  ObjectType mType = ObjectType::Document;
  Ptr<nsIChannel> mChannel;
  Ptr<nsFrameLoader> mFrameLoader;
  Ptr<FeaturePolicy> mFeaturePolicy;
  nsIURI* mURI = nullptr;
  Element element;
  nsIDocShell* shell = nullptr;
  Element* AsElement() { return &element; }
  nsIDocShell* SetupDocShell(nsIURI*) { return shell; }
  static nsIPrincipal* GetFeaturePolicyDefaultOrigin(Element* node) { return &node->origin; }
  void RefreshFeaturePolicy();
  void MaybeStoreCrossOriginFeaturePolicy();
  nsresult DocumentArm();
};

// PRODUCTION_METHODS

struct Fixture {
  nsObjectLoadingContent object;
  nsIChannel channel;
  nsIDocShell shell;
  BrowsingContext context;
  nsFrameLoader loader;
  nsIURILoader uriLoader;
  ContentChild child;
  Fixture() {
    order.clear();
    loader.context = &context; shell.context = &context;
    object.mChannel = &channel; object.mFrameLoader = &loader; object.shell = &shell;
    object.element.document.policy.origin = 11;
    ContentChild::instance = &child; components::URILoader::value = &uriLoader;
  }
  ~Fixture() { ContentChild::instance = nullptr; components::URILoader::value = nullptr; }
};

int main() {
  try {
    for (bool remote : {false, true}) {
      Fixture f; f.loader.remote = remote;
      CHECK(f.object.DocumentArm() == NS_OK);
      CHECK(f.uriLoader.hadPolicyAtOpen);
      CHECK(f.child.sent == 1 && f.child.context == &f.context);
      CHECK(f.child.info->origin == 7 && f.child.info->parent == 11);
      CHECK((order == std::vector<std::string>{"policy", "open", "start"}));
      CHECK(f.channel.flags == 9);
    }
    { Fixture f; f.object.mChannel = nullptr;
      CHECK(f.object.DocumentArm() == NS_ERROR_FAILURE); CHECK(order.empty()); }
    { Fixture f; f.object.shell = nullptr;
      CHECK(f.object.DocumentArm() == NS_ERROR_FAILURE); CHECK(order.empty()); }
    { Fixture f; components::URILoader::value = nullptr;
      (void)f.object.DocumentArm(); CHECK(f.loader.destroyed); CHECK(f.child.sent == 1);
      CHECK((order == std::vector<std::string>{"policy"})); }
    { Fixture f; f.uriLoader.result = NS_ERROR_FAILURE;
      CHECK(f.object.DocumentArm() == NS_ERROR_FAILURE);
      CHECK((order == std::vector<std::string>{"policy", "open"})); }
    for (unsigned denial = 0; denial < 5; ++denial) {
      Fixture f;
      if (denial == 0) f.object.mType = ObjectType::Loading;
      if (denial == 1) f.loader.existingDocShell = false;
      if (denial == 2) f.loader.context = nullptr;
      if (denial == 3) f.context.subframe = false;
      if (denial == 4) f.object.element.composed = false;
      f.object.RefreshFeaturePolicy(); CHECK(f.child.sent == 0);
    }
    { Fixture f; ContentChild::instance = nullptr;
      f.object.RefreshFeaturePolicy(); CHECK(f.child.sent == 0); }
    { Fixture f; f.object.RefreshFeaturePolicy();
      f.object.element.origin.identity = 19;
      f.object.element.document.policy.origin = 22; f.object.RefreshFeaturePolicy();
      CHECK(f.child.sent == 2 && f.child.context == &f.context);
      CHECK(f.child.info->origin == 19 && f.child.info->parent == 22); }
    std::cout << "object container publication checks passed: " << checks << '\n';
  } catch (const std::exception& error) {
    std::cerr << "failed: " << error.what() << " after " << checks << " checks\n";
    return 1;
  }
}
