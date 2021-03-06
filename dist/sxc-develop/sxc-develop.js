(function () {

    angular.module("SourceEditor", [
            "EavConfiguration",
            "EavServices",
            "SxcServices",
            "SxcTemplates",
            "pascalprecht.translate",
            "ui.ace"
        ])
        .config(["$translatePartialLoaderProvider", function($translatePartialLoaderProvider) {
            // ensure the language pack is loaded
            $translatePartialLoaderProvider.addPart("source-editor-snippets");
        }]);

} ());
(function () {

    EditorController.$inject = ["sourceSvc", "snippetSvc", "appAssetsSvc", "appId", "sxcDialogs", "item", "$uibModalInstance", "$window", "$scope", "$translate", "saveToastr", "ctrlS", "debugState"];
    angular.module("SourceEditor")
        .controller("Editor", EditorController)
    ;

    function EditorController(sourceSvc, snippetSvc, appAssetsSvc, appId, sxcDialogs, item, $uibModalInstance, $window, $scope, $translate, saveToastr, ctrlS, debugState) {
        $translate.refresh();   // necessary to load stuff added in this lazy-loaded app

        var vm = this;
        vm.debug = debugState;

        // if item is an object with EntityId, it referrs to a template, otherwise it's a relative path

        var svc = sourceSvc(item.EntityId !== undefined ? item.EntityId : item.Path);

        vm.view = {};
        vm.tempCodeBecauseOfBug = "";
        vm.editor = null;

        svc.get().then(function (result) {
            vm.view = result.data;
            svc.initSnippets(vm.view);
        });

        // load appropriate snippets from the snippet service
        svc.initSnippets = function (template) {
            vm.snipSvc = snippetSvc(template, ace);
            vm.snipSvc.getSnippets().then(function (result) {
                vm.snippets = result;
                vm.snippetSet = "Content";    // select default
                vm.snippetHelp = vm.snipSvc.help;
                vm.snippetLabel = vm.snipSvc.label;

                // now register the snippets in the editor
                vm.registerSnippets();
            });
        };

        //#region close / prevent-close
        vm.close = function () {
            if (!confirm($translate.instant("Message.ExitOk")))
                return;
            window.close();
        };
        
        // prevent all kind of closing when accidentally just clicking on the side of the dialog
        $scope.$on("modal.closing", function (e) { e.preventDefault(); });

        $window.addEventListener("beforeunload", function (e) {
            var unsavedChangesText = $translate.instant("Message.ExitOk");
            (e || window.event).returnValue = unsavedChangesText; //Gecko + IE
            return unsavedChangesText; //Gecko + Webkit, Safari, Chrome etc.
        });

        //#endregion

        //#region save
        vm.save = function (autoClose) {
            var after = autoClose ? vm.close : function () { };

            //#region bugfix 607
            // check if there is still some temp-snippet which we must update first 
            // - because of issue https://github.com/2sic/2sxc/issues/607
            // it's very important that we place the text into a copy of the variable
            // and NOT in the view.Code, otherwise undo will stop working
            var latestCode = vm.editor.getValue();
            var savePackage = angular.copy(vm.view);
            if (savePackage.Code !== latestCode) //{
                savePackage.Code = latestCode;
            //#endregion

            // now save with appropriate toaster
            saveToastr(svc.save(savePackage)).then(after);
        };
        //#endregion

        activate();

        function activate() {
            // add ctrl+s to save
            ctrlS(function () { vm.save(false); });


        }

        //#region show file picker
        vm.browser = {
            show: false,
            svc: appAssetsSvc(appId),
            toggle: function() {
      
                vm.browser.show = !vm.browser.show;
                if (!vm.assets)
                    vm.assets = vm.browser.svc.liveList();
            },
            editFile: function(filename) {
                window.open(vm.browser.assembleUrl(filename));
                vm.browser.toggle();
            },
            assembleUrl: function(newFileName) {
                // note that as of now, we'll just use the initial url and change the path
                // then open a new window
                var url = window.location.href;
                var newItems = JSON.stringify([{ Path: newFileName }]);
                return url.replace(new RegExp("items=.*?%5d", "i"), "items=" + encodeURI(newItems)); // note: sometimes it doesn't have an appid, so it's [0-9]* instead of [0-9]+
            },
            addFile: function () {
                // todo: i18n
                var result = prompt("please enter full file name"); // $translate.instant("AppManagement.Prompt.NewApp"));
                if (result)
                    vm.browser.svc.create(result);

            }
        };

        //#endregion

        //#region snippets
        vm.addSnippet = function addSnippet(snippet) {
            var snippetManager = ace.require("ace/snippets").snippetManager;
            snippetManager.insertSnippet(vm.editor, snippet);
            vm.editor.focus();
        };

        vm.registerSnippets = function registerSnippets() {
            // ensure we have everything first (this may be called multiple times), then register them
            if (!(vm.snipSvc && vm.editor))
                return;
            vm.snipSvc.registerInEditor();
        };
        //#endregion

        // this event is called when the editor is ready
        vm.aceLoaded = function (_editor) {
            vm.editor = _editor;        // remember the editor for later actions
            vm.registerSnippets();      // try to register the snippets
        };

    }

}());
// This service delivers all snippets, translated etc. to the sourc-editor UI
angular.module("SourceEditor")
    .factory("snippetSvc", ["$http", "eavConfig", "svcCreator", "$translate", "contentTypeFieldSvc", "$q", function ($http, eavConfig, svcCreator, $translate, contentTypeFieldSvc, $q) {

        // Construct a service for this specific appId
        return function createSvc(templateConfiguration, ace) {

            var svc = {
                cachedSnippets: {},
                //inputTypeSnippets: {},
                inputTypes: InputTypeSnippetHandler(),
                loaded: false,
                list: [], // snippets as list in a format for the editor
                tree: null, // snippets as tree for the drop-down tool
                ace: ace, // source editor object


                // #region load jsons and prepare for binding as tree and for the editor
                /// Main function, loads all snippets, translates
                /// returns the object tree as a promise
                getSnippets: function() {
                    if (svc.loaded)
                        return $q(function(resolve, reject) { resolve(svc.cachedSnippets); });

                    return svc.loadTable().then(function(result) {
                        // filter for token/razor snippets
                        var relevant = svc.filterAwayNotNeededSnippetsList(result.data.snippets);
                        svc.inputTypes.extractInputTypeSnippets(relevant, svc.list);

                        var sets = svc.initSnippetsWithConfig(svc.list);
                        for (var x in sets)
                            svc.cachedSnippets[x] = sets[x];
                        svc.loaded = true;
                        return (svc.cachedSnippets);
                    });
                },

                initSnippetsWithConfig: function(sets) {
                    sets = svc.tree = svc.makeTree(sets);

                    //#region Retrieve all relevant content-types and infos
                    sets.Content = angular.extend({}, sets.Content, { Fields: {}, PresentationFields: {} });
                    if (templateConfiguration.TypeContent)
                        svc.loadContentType(sets.Content.Fields, templateConfiguration.TypeContent, "Content");
                    if (templateConfiguration.TypeContentPresentation)
                        svc.loadContentType(sets.Content.PresentationFields, templateConfiguration.TypeContentPresentation, "Content.Presentation");

                    if (templateConfiguration.HasList) {
                        sets.List = angular.extend({}, sets.List, { Fields: {}, PresentationFields: {} });
                        if (templateConfiguration.TypeList)
                            svc.loadContentType(sets.List.Fields, templateConfiguration.TypeList, "ListContent");
                        if (templateConfiguration.TypeListPresentation)
                            svc.loadContentType(sets.List.PresentationFields, templateConfiguration.TypeListPresentation, "ListContent.Presentation");
                    } else 
                        delete sets.List;

                    // maybe App-infos
                    if (templateConfiguration.HasApp) {
                        sets.App.Resources = {};
                        sets.App.Settings = {};
                        svc.loadContentType(sets.App.Resources, "App-Resources", "App.Resources");
                        svc.loadContentType(sets.App.Settings, "App-Settings", "App.Settings");
                    }
                    //#endregion

                    svc.cachedSnippets = sets;
                    return sets;
                },

                // load snippets from server
                loadTable: function() {
                    return $http.get("../sxc-develop/snippets.json.js");
                },

                // Convert the list into a tree with set/subset/item
                makeTree: function(list) {
                    var tree = {};
                    for (var i = 0; i < list.length; i++) {
                        var o = list[i];
                        if (tree[o.set] === undefined)
                            tree[o.set] = {};
                        if (tree[o.set][o.subset] === undefined)
                            tree[o.set][o.subset] = [];
                        var reformatted = { "key": o.name, "label": svc.label(o.set, o.subset, o.name), "snip": o.content, "help": o.help || svc.help(o.set, o.subset, o.name) };

                        tree[o.set][o.subset].push(reformatted);
                    }
                    return tree;
                },
                // #endregion

                //#region help / translate
                help: function help(set, subset, snip) {
                    var key = svc.getHelpKey(set, subset, snip, ".Help");

                    var result = $translate.instant(key);
                    if (result === key)
                        result = "";
                    return result;
                },

                label: function label(set, subset, snip) {
                    var key = svc.getHelpKey(set, subset, snip, ".Key");

                    var result = $translate.instant(key);
                    if (result === key)
                        result = snip;
                    return result;
                },

                getHelpKey: function(set, subset, snip, addition) {
                    return "SourceEditorSnippets" + "." + set + "." + subset + "." + snip + addition;
                },

                //#endregion

                //#region scan the configuration and filter unneeded snippets

                // scan the list for sets starting with @ or [ and filter if not needed right now
                filterAwayNotNeededSnippetsList: function(list) {
                    var newList = [];
                    for (var i = 0; i < list.length; i++) {
                        var itm = list[i];
                        var setHasPrefix = svc.keyPrefixes.indexOf(itm.set[0]);
                        if (setHasPrefix === -1 || (setHasPrefix === svc.keyPrefixIndex)) {
                            // if necessary, remove first char
                            if (setHasPrefix === svc.keyPrefixIndex)
                                itm.set = itm.set.substr(1);

                            newList.push(itm);
                        }
                    }
                    return newList;
                },


                keyPrefixes: ["@", "["],
                keyPrefixIndex: (templateConfiguration.Type.indexOf("Razor") > -1) ? 0 : 1,
                //#endregion

                //#region get fields in content types
                loadContentType: function(target, type, prefix) {
                    contentTypeFieldSvc(templateConfiguration.AppId, { StaticName: type }).getFields()
                        .then(function(result) {
                            // first add common items if the content-type actually exists
                            angular.forEach(result.data, function(value) {
                                var fieldname = value.StaticName;
                                target[fieldname] = {
                                    key: fieldname,
                                    label: fieldname,
                                    snip: svc.valuePlaceholder(prefix, fieldname),
                                    help: value.Metadata.merged.Notes || "" + " (" + value.Type.toLowerCase() + ") "
                                };
                        
                                // try to add generic snippets specific to this input-type
                                var snipDefaults = angular.copy(target[fieldname]); // must be a copy, because target[fieldname] will grow

                                svc.inputTypes.attachSnippets(target, prefix, fieldname, value.InputType, snipDefaults);
                            });

                            var std = ["EntityId", "EntityTitle", "EntityGuid", "EntityType", "IsPublished", "Modified"];
                            if (result.data.length)
                                for (var i = 0; i < std.length; i++)
                                    target[std[i]] = {
                                        key: std[i],
                                        label: std[i],
                                        snip: svc.valuePlaceholder(prefix, std[i]),
                                        help: $translate.instant("SourceEditorSnippets.StandardFields." + std[i] + ".Help")
                                    };

                        });
                },

                valuePlaceholder: function(obj, val) {
                    return (templateConfiguration.Type.indexOf("Razor") > -1)
                        ? "@" + obj + "." + val
                        : "[" + obj.replace(".", ":") + ":" + val + "]";
                },

                //#endregion

                /// add the list to the snippet manager so it works for typing
                registerInEditor: function () {
                    if (svc.list === null)
                        throw "can't register snippets because list is not loaded";
                    var snippetManager = ace.require("ace/snippets").snippetManager;
                    snippetManager.register(svc.list);
                }
            };


            return svc;
        };

        function InputTypeSnippetHandler() {
            var itsh = {
                inputTypeSnippets: {},

                extractInputTypeSnippets: function(list, standardArray) {
                    var inputTypeArray = [];

                    for (var i = 0; i < list.length; i++) {
                        var itm = list[i];
                        var systemSnippet = itm.set[0] === "\\";
                        if (!systemSnippet)
                            standardArray.push(itm);
                        else {
                            itm.set = itm.set.substr(1);
                            inputTypeArray.push(itm);
                        }
                    }
                    itsh.inputTypeSnippets = itsh.catalogInputTypeSnippets(inputTypeArray);
                },

                catalogInputTypeSnippets: function(list) {
                    var inputTypeList = {};
                    for (var i = 0; i < list.length; i++) {
                        if (inputTypeList[list[i].subset] === undefined)
                            inputTypeList[list[i].subset] = [];
                        inputTypeList[list[i].subset].push(list[i]);
                    }
                    return inputTypeList;
                },

                attachSnippets: function(target, prefix, fieldname, inputType, snipDefaults) {
                    var genericSnippet = itsh.inputTypeSnippets[inputType];
                    if (inputType.indexOf("-")) {   // if it's a sub-type, let's also get the master-type
                        var fieldType = inputType.substr(0, inputType.indexOf("-"));
                        if (fieldType) {
                            var typeSnips = itsh.inputTypeSnippets[fieldType];
                            if (typeSnips)
                                genericSnippet = genericSnippet ? genericSnippet.concat(typeSnips) : typeSnips;
                        }
                    }
                    if (!genericSnippet)
                        return;

                    if (target[fieldname].more === undefined)
                        target[fieldname].more = [];
                    var fieldSnips = target[fieldname].more;
                    for(var g = 0;g < genericSnippet.length;g++)
                        try {
                            fieldSnips[fieldname + "-" + genericSnippet[g].name] = angular.extend({}, snipDefaults, {
                                key: fieldname + " - " + genericSnippet[g].name,
                                label: genericSnippet[g].name,
                                snip: itsh.localizeGenericSnippet(genericSnippet[g].content, prefix, fieldname),
                                collapse: true
                            });
                        } finally {
                        }

                },

                localizeGenericSnippet: function(snip, objName, fieldName) {
                    snip = snip.replace(/(\$\{[0-9]+\:)var(\})/gi, "$1" + objName + "$2")
                        .replace(/(\$\{[0-9]+\:)prop(\})/gi, "$1" + fieldName + "$2");
                    return snip;
                }
            };
            return itsh;
        }
    }]);

angular.module("SourceEditor")
    .factory("sourceSvc", ["$http", function($http) {

        // Construct a service for this specific appId
        return function createSvc(key) {

            // if the key is a string, then it's to be used as a path, otherwise as a template-id
            var params = isNaN(key)
                ? { path: key }
                : { templateId: key };

            var svc = {
                get: function() {
                    return $http.get("app/appassets/asset", { params: params })
                        .then(function(result) {
                            var data = result.data;
                            if (data.Type.toLowerCase() === "auto") {
                                switch(data.Extension.toLowerCase()) {
                                    case ".cs":
                                    case ".cshtml":
                                        data.Type = "Razor";
                                        break;
                                    case ".html":
                                    case ".css":
                                    case ".js":
                                        data.Type = "Token";
                                        break;
                                }
                            }
                            return result;
                        });
                },

                save: function(item) {
                    return $http.post("app/appassets/asset", item, { params: params });
                }
            };

            return svc;
        };
    }]);
(function () {

    angular.module("SourceEditor")

        // helps convert an object with keys to an array to allow sorting
        // from https://github.com/petebacondarwin/angular-toArrayFilter
        .filter('toArray', function() {
            return function(obj, addKey) {
                if (!angular.isObject(obj)) return obj;
                if (addKey === false) {
                    return Object.keys(obj).map(function(key) {
                        return obj[key];
                    });
                } else {
                    return Object.keys(obj).map(function(key) {
                        var value = obj[key];
                        return angular.isObject(value) ?
                            Object.defineProperty(value, '$key', { enumerable: false, value: key }) :
                            { $key: key, $value: value };
                    });
                }
            };
        });


} ());
angular.module('SourceEditor').run(['$templateCache', function($templateCache) {
  'use strict';

  $templateCache.put('source-editor/editor.html',
    "<div ng-click=vm.debug.autoEnableAsNeeded($event)><div class=modal-header><h3 class=modal-title translate=SourceEditor.Title></h3></div><div class=modal-body><div class=row><div class=col-md-8><div uib-tooltip=\"{{ vm.view.FileName }}\" ng-click=vm.browser.toggle()>{{ vm.view.FileName.substr(vm.view.FileName.lastIndexOf(\"\\\\\") + 1) }} ({{vm.view.Type }}) <i ng-class=\"{&quot;icon-eav-plus-squared&quot;: !vm.browser.show, &quot;icon-eav-minus-squared&quot;: vm.browser.show}\"></i></div><div ng-if=vm.browser.show><h4>quick-pick another file</h4><ol><li ng-repeat=\"asset in vm.assets\" ng-click=vm.browser.editFile(asset)>{{asset}}</li></ol><ul><li ng-click=vm.browser.addFile()>create file <span class=icon-eav-plus-circled></span></li><li>for copy, rename etc. please use the dnn file manager</li></ul></div><div ng-model=vm.view.Code style=\"height: 600px\" ui-ace=\"{\r" +
    "\n" +
    "                    useWrapMode : true,\r" +
    "\n" +
    "                    useSoftTabs: true,\r" +
    "\n" +
    "                    showGutter: true,\r" +
    "\n" +
    "                    theme:'sqlserver',\r" +
    "\n" +
    "                    mode: 'razor',\r" +
    "\n" +
    "                    onLoad: vm.aceLoaded,\r" +
    "\n" +
    "                    require: ['ace/ext/language_tools', '//xyz/something'],\r" +
    "\n" +
    "                    advanced: {\r" +
    "\n" +
    "                        enableSnippets: true,\r" +
    "\n" +
    "                        enableBasicAutocompletion: true,\r" +
    "\n" +
    "                        enableLiveAutocompletion: true\r" +
    "\n" +
    "                    },\r" +
    "\n" +
    "                    rendererOptions: {\r" +
    "\n" +
    "                        fontSize: 16\r" +
    "\n" +
    "                    }\r" +
    "\n" +
    "                }\"></div></div><div class=\"pull-right col-md-4\"><div><strong translate=SourceEditor.SnippetsSection.Title></strong> <i icon=question-sign style=\"opacity: 0.3\" ng-click=\"showSnippetInfo = !showSnippetInfo\"></i><div ng-if=showSnippetInfo translate=SourceEditor.SnippetsSection.Intro></div></div><select class=input-lg style=\"width: 90%\" ng-model=vm.snippetSet ng-options=\"key as ('SourceEditorSnippets.' + key + '.Title' | translate) for (key , value) in vm.snippets\" uib-tooltip=\"{{ 'SourceEditorSnippets.' + vm.snippetSet + '.Help'  | translate}}\"></select><div>&nbsp;</div><div style=\"height: 500px; overflow: auto\"><div ng-repeat=\"(subsetName, subsetValue) in vm.snippets[vm.snippetSet]\"><strong uib-tooltip=\"{{ 'SourceEditorSnippets.' + vm.snippetSet + '.' + subsetName + '.Help'  | translate}}\">{{ 'SourceEditorSnippets.' + vm.snippetSet + '.' + subsetName + '.Title' | translate}}</strong><ul><li ng-repeat=\"value in subsetValue | toArray | orderBy: '$key'\" uib-tooltip=\"{{ value.snip }}\"><span ng-click=vm.addSnippet(value.snip)>{{value.label}}</span> <a ng-show=value.more ng-click=\"showMore = !showMore\"><i icon=plus></i>more</a> <i icon=info-sign style=\"opacity: 0.3\" ng-click=\"show = !show\" ng-show=value.help></i><div ng-if=show><em>{{value.help}}</em></div><ul ng-if=showMore><li ng-repeat=\"more in value.more | toArray | orderBy: '$key'\" uib-tooltip=\"{{ value.snip }}\"><span ng-click=vm.addSnippet(more.snip)>{{more.label}}</span> <i icon=info-sign style=\"opacity: 0.3\" ng-click=\"show = !show\" ng-show=more.help></i><div ng-if=show><em>{{more.help}}</em></div></li></ul></li></ul></div></div></div></div></div><div class=modal-footer><div class=pull-left><button class=\"btn btn-primary btn-lg xxbtn-square\" type=button ng-click=vm.save(false)><span icon=check uib-tooltip=\"{{ 'Button.SaveAndKeepOpen' | translate }}\"></span> {{ 'Button.SaveAndKeepOpen' | translate }}</button> also supports Ctrl+S</div></div><show-debug-availability class=pull-right></show-debug-availability><div ng-if=vm.debug.on><pre>{{vm.view.Code}}</pre></div></div><style>/* helper to ensure that razor (which is correctly detected by ACE) is also highlighted */\r" +
    "\n" +
    "    .ace_razor {\r" +
    "\n" +
    "        background-color: yellow;\r" +
    "\n" +
    "    }\r" +
    "\n" +
    "\r" +
    "\n" +
    "    /* make sure the highlighted text is also black, otherwise it a kind of gray */\r" +
    "\n" +
    "    .ace_punctuation.ace_short.ace_razor {\r" +
    "\n" +
    "        color: black;\r" +
    "\n" +
    "    }\r" +
    "\n" +
    "\r" +
    "\n" +
    "    .ace_punctuation.ace_block.ace_razor {\r" +
    "\n" +
    "        color: black;\r" +
    "\n" +
    "    }</style>"
  );

}]);
