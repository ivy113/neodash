import { createDriver } from "use-neo4j";
import { initializeSSO } from "../component/sso/SSOUtils";
import { loadDashboardFromNeo4jByNameThunk, loadDashboardFromNeo4jByUUIDThunk, loadDashboardThunk } from "../dashboard/DashboardThunks";
import { createNotificationThunk } from "../page/PageThunks";
import { QueryStatus, runCypherQuery } from "../report/ReportQueryRunner";
import {
    setConnected, setConnectionModalOpen, setConnectionProperties, setDesktopConnectionProperties,
    resetShareDetails, setShareDetailsFromUrl, setWelcomeScreenOpen, setDashboardToLoadAfterConnecting,
    setOldDashboard, clearDesktopConnectionProperties, clearNotification, setSSOEnabled, setStandaloneEnabled,
    setAboutModalOpen, setStandaloneMode, setStandaloneDashboardDatabase, setWaitForSSO
} from "./ApplicationActions";

/**
 * Application Thunks (https://redux.js.org/usage/writing-logic-thunks) handle complex state manipulations.
 * Several actions/other thunks may be dispatched from here.
 */

/**
 * Establish a connection to Neo4j with the specified credentials. Open/close the relevant windows when connection is made (un)successfully.
 * @param protocol - the neo4j protocol (e.g. bolt, bolt+s, neo4j+s, ...)
 * @param url - URL of the host.
 * @param port - port on which Neo4j is running.
 * @param database - the Neo4j database to connect to.
 * @param username - Neo4j username.
 * @param password - Neo4j password.
 */
export const createConnectionThunk = (protocol, url, port, database, username, password) => (dispatch: any, getState: any) => {
    try {
        const driver = createDriver(protocol, url, port, username, password)
        console.log("Attempting to connect...")
        const validateConnection = (records) => {
            console.log("Confirming connection was established...")
            if (records && records[0] && records[0]["error"]) {
                dispatch(createNotificationThunk("Unable to establish connection", records[0]["error"]));
            } else if (records && records[0] && records[0].keys[0] == "connected") {

                dispatch(setConnectionProperties(protocol, url, port, database, username, password));
                dispatch(setConnectionModalOpen(false));
                dispatch(setConnected(true));

                // If we have remembered to load a specific dashboard after connecting to the database, take care of it here.
                const application = getState().application;
                if (application.dashboardToLoadAfterConnecting && application.dashboardToLoadAfterConnecting.startsWith("http")) {
                    fetch(application.dashboardToLoadAfterConnecting)
                        .then(response => response.text())
                        .then(data => dispatch(loadDashboardThunk(data)));
                    dispatch(setDashboardToLoadAfterConnecting(null));
                } else if (application.dashboardToLoadAfterConnecting) {
                    const setDashboardAfterLoadingFromDatabase = (value) => {
                        dispatch(loadDashboardThunk(value));
                    }

                    // If we specify a dashboard by name, load the latest version of it
                    if (application.dashboardToLoadAfterConnecting.startsWith('name:')) {
                        dispatch(loadDashboardFromNeo4jByNameThunk(driver, application.standaloneDashboardDatabase, application.dashboardToLoadAfterConnecting.substring(5), setDashboardAfterLoadingFromDatabase));
                    } else {
                        dispatch(loadDashboardFromNeo4jByUUIDThunk(driver, application.standaloneDashboardDatabase, application.dashboardToLoadAfterConnecting, setDashboardAfterLoadingFromDatabase));
                    }
                    dispatch(setDashboardToLoadAfterConnecting(null));
                }
            } else {
                dispatch(createNotificationThunk("Unknown Connection Error", "Check the browser console."));
            }
        }
        runCypherQuery(driver, database, "RETURN true as connected", {}, {}, ["connected"], 1, () => { return }, (records) => validateConnection(records))
    } catch (e) {
        dispatch(createNotificationThunk("Unable to establish connection", e));
    }
}

/**
 * Establish a connection directly from the Neo4j Desktop integration (if running inside Neo4j Desktop)
 */
export const createConnectionFromDesktopIntegrationThunk = () => (dispatch: any, getState: any) => {
    try {
        const desktopConnectionDetails = getState().application.desktopConnection;
        const protocol = desktopConnectionDetails.protocol;
        const url = desktopConnectionDetails.url;
        const port = desktopConnectionDetails.port;
        const database = desktopConnectionDetails.database;
        const username = desktopConnectionDetails.username;
        const password = desktopConnectionDetails.password;
        dispatch(createConnectionThunk(protocol, url, port, database, username, password));
    } catch (e) {
        dispatch(createNotificationThunk("Unable to establish connection to Neo4j Desktop", e));
    }
}

/**
 * Find the active database from Neo4j Desktop.
 * Set global state values to remember the values retrieved from the integration so that we can connect later if possible.
 */
export const setDatabaseFromNeo4jDesktopIntegrationThunk = () => (dispatch: any, getState: any) => {
    const getActiveDatabase = (context) => {
        for (let pi = 0; pi < context.projects.length; pi++) {
            let prj = context.projects[pi];
            for (let gi = 0; gi < prj.graphs.length; gi++) {
                let grf = prj.graphs[gi];
                if (grf.status == 'ACTIVE') {
                    return grf;
                }
            }
        }
        // No active database found - ask for manual connection details.
        return null;
    }

    let promise = window.neo4jDesktopApi && window.neo4jDesktopApi.getContext();

    if (promise) {
        promise.then(function (context) {
            let neo4j = getActiveDatabase(context);
            if (neo4j) {
                dispatch(setDesktopConnectionProperties(
                    neo4j.connection.configuration.protocols.bolt.url.split("://")[0],
                    neo4j.connection.configuration.protocols.bolt.url.split("://")[1].split(":")[0],
                    neo4j.connection.configuration.protocols.bolt.port,
                    undefined,
                    neo4j.connection.configuration.protocols.bolt.username,
                    neo4j.connection.configuration.protocols.bolt.password));
            }
        });
    }
}

/**
 * On application startup, check the URL to see if we are loading a shared dashboard.
 * If yes, decode the URL parameters and set the application state accordingly, so that it can be loaded later.
 */
export const handleSharedDashboardsThunk = () => (dispatch: any, getState: any) => {
    try {
        const queryString = window.location.search;
        const urlParams = new URLSearchParams(queryString);
        if (urlParams.get("share") !== null) {
            const id = decodeURIComponent(urlParams.get("id"));
            const type = urlParams.get("type");
            const standalone = urlParams.get("standalone") == "Yes";
            if (urlParams.get("credentials")) {
                const connection = decodeURIComponent(urlParams.get("credentials"));
                const protocol = connection.split("://")[0];
                const username = connection.split("://")[1].split(":")[0];
                const password = connection.split("://")[1].split(":")[1].split("@")[0];
                const database = connection.split("@")[1].split(":")[0];
                const url = connection.split("@")[1].split(":")[1];
                const port = connection.split("@")[1].split(":")[2];
                dispatch(setShareDetailsFromUrl(type, id, standalone, protocol, url, port, database, username, password));
                window.history.pushState({}, document.title, "/");
            } else {
                dispatch(setShareDetailsFromUrl(type, id, undefined, undefined, undefined, undefined, undefined, undefined, undefined));
                window.history.pushState({}, document.title, "/");
            }
        } else {
            // dispatch(resetShareDetails());
        }

    } catch (e) {
        dispatch(createNotificationThunk("Unable to load shared dashboard", "You have specified an invalid/incomplete share URL. Try regenerating the share URL from the sharing window."));
    }
}


/**
 * Confirm that we load a shared dashboard. This requires that the state was previously set in `handleSharedDashboardsThunk()`.
 */
export const onConfirmLoadSharedDashboardThunk = () => (dispatch: any, getState: any) => {
    try {
        const state = getState();
        const shareDetails = state.application.shareDetails;
        dispatch(setWelcomeScreenOpen(false));
        dispatch(setDashboardToLoadAfterConnecting(shareDetails.id));
        if (shareDetails.dashboardDatabase) {
            dispatch(setStandaloneDashboardDatabase(shareDetails.dashboardDatabase));
            dispatch(setStandaloneDashboardDatabase(shareDetails.database));
        }
        if (shareDetails.url) {
            dispatch(createConnectionThunk(shareDetails.protocol, shareDetails.url, shareDetails.port, shareDetails.database, shareDetails.username, shareDetails.password));
        } else {
            dispatch(setConnectionModalOpen(true));
        }
        if (shareDetails.standalone == true) {
            dispatch(setStandaloneMode(true));
        }
        dispatch(resetShareDetails());
    } catch (e) {
        dispatch(createNotificationThunk("Unable to load shared dashboard", "The provided connection or dashboard identifiers are invalid. Try regenerating the share URL from the sharing window."));
    }
}


/**
 * Initializes the NeoDash application.
 * 
 * This is a multi step process, starting with loading the runtime configuration.
 * This is present in the file located at /config.json on the URL where NeoDash is deployed.
 * Note: this does not work in Neo4j Desktop, so we revert to defaults.
 */
export const loadApplicationConfigThunk = () => async (dispatch: any, getState: any) => {
    var config = {
        ssoEnabled: false,
        ssoDiscoveryUrl: "http://example.com",
        standalone: false,
        standaloneProtocol: "neo4j",
        standaloneHost: "localhost",
        standalonePort: "7687",
        standaloneDatabase: "neo4j",
        standaloneDashboardName: "My Dashboard",
        standaloneDashboardDatabase: "dashboards"
    };
    try {
        config = await (await fetch("config.json")).json();
    } catch (e) {
        // Config may not be found, for example when we are in Neo4j Desktop.
        console.log("No config file detected. Setting to safe defaults.");
    }

    try {
        const clearNotificationAfterLoad = true;
        dispatch(setSSOEnabled(config['ssoEnabled'], config["ssoDiscoveryUrl"]));
        const state = getState();
        const standalone = config['standalone'];// || (state.application.shareDetails !== undefined && state.application.shareDetails.standalone);
        dispatch(setStandaloneEnabled(standalone, config['standaloneProtocol'], config['standaloneHost'], config['standalonePort'], config['standaloneDatabase'], config['standaloneDashboardName'], config['standaloneDashboardDatabase']))
        dispatch(setConnectionModalOpen(false));
        if (state.application.waitForSSO) {
            // We just got redirected from the SSO provider. Hide all windows and attempt the connection.
            dispatch(setAboutModalOpen(false));
            dispatch(setConnected(false));
            dispatch(setWelcomeScreenOpen(false));
            const success = await initializeSSO(config["ssoDiscoveryUrl"], (credentials) => {
                if (standalone) {
                    dispatch(setConnectionProperties(config['standaloneProtocol'], config['standaloneHost'], config['standalonePort'], config['standaloneDatabase'], credentials['username'], credentials['password']));
                    dispatch(createConnectionThunk(config['standaloneProtocol'], config['standaloneHost'], config['standalonePort'], config['standaloneDatabase'], credentials['username'], credentials['password']));
                    dispatch(setDashboardToLoadAfterConnecting("name:" + config['standaloneDashboardName']));
                }
            });
            dispatch(setWaitForSSO(false));
            if (!success) {
                alert("Unable to connect using SSO");
                dispatch(createNotificationThunk("Unable to connect using SSO", "Something went wrong. Most likely your credentials are incorrect..."));
            } else {
                return;
            }
        }

        if (standalone) {
            // If we are running in standalone mode, auto-set the connection details that are configured.
            dispatch(setConnectionProperties(
                config['standaloneProtocol'],
                config['standaloneHost'],
                config['standalonePort'],
                config['standaloneDatabase'],
                config['standaloneUsername'] ? config['standaloneUsername'] : state.application.connection.username,
                config['standalonePassword'] ? config['standalonePassword'] : state.application.connection.password));

            dispatch(setAboutModalOpen(false));
            dispatch(setConnected(false));
            dispatch(setWelcomeScreenOpen(false));
            dispatch(setDashboardToLoadAfterConnecting("name:" + config['standaloneDashboardName']));

            if (clearNotificationAfterLoad) {
                dispatch(clearNotification());
            }

            // Override for when username and password are specified in the config - automatically connect to the specified URL.
            if (config['standaloneUsername'] && config['standalonePassword']) {
                dispatch(createConnectionThunk(config['standaloneProtocol'],
                    config['standaloneHost'],
                    config['standalonePort'],
                    config['standaloneDatabase'],
                    config['standaloneUsername'],
                    config['standalonePassword']));
            } else {
                dispatch(setConnectionModalOpen(true));
            }
        } else {
            dispatch(clearDesktopConnectionProperties());
            dispatch(setDatabaseFromNeo4jDesktopIntegrationThunk());
            const old = localStorage.getItem('neodash-dashboard');
            dispatch(setOldDashboard(old));
            dispatch(setConnected(false));
            dispatch(setDashboardToLoadAfterConnecting(null));
            dispatch(setWelcomeScreenOpen(true));
            if (clearNotificationAfterLoad) {
                dispatch(clearNotification());
            }
            dispatch(handleSharedDashboardsThunk());
            dispatch(setConnectionModalOpen(false));
            dispatch(setAboutModalOpen(false));
        }
    } catch (e) {
        dispatch(setWelcomeScreenOpen(false));
        dispatch(createNotificationThunk("Unable to load application configuration", "Do you have a valid config.json deployed with your application?"));
    }
}