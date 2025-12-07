import { create } from "zustand";
import { router } from "expo-router";
import { Pedometer } from "expo-sensors";
import { Alert, Platform } from "react-native";
import { Content, Part, GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_API_KEY } from "@/Keys";
import {
  UserData,
  Activity,
  ExerciseData,
  Meal,
  MealData,
  ChatMessage,
} from "@/global";
import * as FileSystem from "expo-file-system";

// ---------- Mock user / auth / firestore so RNGoogleSignin & Firebase
// ---------- don't crash Expo Go while you develop ----------

type MockUser = {
  user: {
    email: string;
    givenName?: string;
    photo?: string;
  };
};

type User = MockUser;

const mockDb: { [key: string]: any } = {};

const GoogleSignin = {
  hasPlayServices: async () => true,
  signIn: async (): Promise<MockUser> => ({
    user: {
      email: "test@example.com",
      givenName: "Test User",
      photo: "",
    },
  }),
  getCurrentUser: async (): Promise<MockUser | null> => null,
  signOut: async () => {},
};

const firestore = () => ({
  collection: (name: string) => ({
    doc: (id: string | undefined) => {
      const key = `${name}:${id}`;
      return {
        get: async () => ({
          exists: !!mockDb[key],
          data: () => mockDb[key],
        }),
        set: async (value: any) => {
          mockDb[key] = value;
        },
        update: async (value: any) => {
          mockDb[key] = { ...(mockDb[key] || {}), ...value };
        },
      };
    },
  }),
});

let subscription: Pedometer.Subscription | null = null;

// ---------- State types ----------

type StateShape = {
  userInfo: User | null;
  userData: UserData;
  activity: Activity;
  refActivity: Activity;
  isExercising: boolean;
  exerciseIntensity: number;
  currentExercise: string | undefined;
  exerciseData: ExerciseData | null;
  exerciseRecord: ExerciseData[];
  activityList: Activity[];
  date: string;
  meals: Meal[];
  mealLoading: boolean;
  mealData: MealData | null;
  messages: ChatMessage[];
  geminiLoading: boolean;
  contextHistory: Content[];
};

type Actions = {
  signIn: () => Promise<void>;
  checkIfAlreadySignedIn: () => Promise<void>;
  signOut: () => Promise<void>;
  setUserData: () => Promise<void>;
  startStepCounter: (userData: UserData) => Promise<void>;
  calculateCalories: (
    steps: number,
    user: UserData,
    intensity: number,
    exercise: string
  ) => number;
  calculateDistance: (
    steps: number,
    user: UserData,
    intensity: number
  ) => number;
  stopStepCounter: () => void;
  startExercise: () => void;
  updateDailyStats: () => Promise<void>;
  fetchCat: (category: string) => Promise<void>;
  fetchIngred: (ingred: string) => Promise<void>;
  fetchMealData: (id: string) => Promise<void>;
  getGeminiResponse: (prompt: string, image?: string | null) => Promise<string>;
  feedInitialGeminiData: (activityList: Activity[]) => Promise<void>;
};

type State = StateShape & Actions;

// ---------- Store ----------

export const useStore = create<State>((set, get) => ({
  userInfo: null,
  userData: {
    weight: 0,
    height: 0,
    stepGoal: 10000,
    caloriesGoal: 700,
    distanceGoal: 3000,
  },
  activity: { steps: 0, caloriesBurnt: 0, distance: 0 },
  refActivity: { steps: 0, caloriesBurnt: 0, distance: 0 },
  currentExercise: "walk",
  exerciseData: null,
  isExercising: false,
  exerciseIntensity: 1,
  exerciseRecord: [],
  activityList: [],
  date: new Date().toISOString().split("T")[0],
  meals: [],
  mealLoading: false,
  mealData: null,
  messages: [],
  geminiLoading: false,
  contextHistory: [],

  // ---------- Auth ----------

  signIn: async () => {
    try {
      await GoogleSignin.hasPlayServices();
      const userInfo = await GoogleSignin.signIn();
      set({ userInfo });

      const userRef = firestore().collection("Users").doc(userInfo.user.email);
      const userSnapshot = await userRef.get();

      if (!userSnapshot.exists) {
        router.navigate("/userdetails");
      } else {
        const data = userSnapshot.data();
        if (data && data.userData) {
          set({
            userData: data.userData,
            exerciseRecord: data.exerciseRecord ?? [],
            activityList: data.activityList ?? [],
          });

          const todaysActivity = get().activityList.find(
            (p: Activity) => p.date?.toString() === get().date.toString()
          );
          if (todaysActivity) {
            set({ activity: todaysActivity });
          }

          get().feedInitialGeminiData(data.activityList ?? []);
          get().startStepCounter(data.userData);
        }
        router.navigate("/(tabs)");
      }
    } catch (error) {
      console.log(error);
    }
  },

  checkIfAlreadySignedIn: async () => {
    const userInfo = await GoogleSignin.getCurrentUser();
    if (userInfo !== null) {
      set({ userInfo });

      const userRef = firestore().collection("Users").doc(userInfo.user.email);
      const userSnapshot = await userRef.get();
      const data = userSnapshot.data();

      if (data) {
        set({ userData: data.userData });

        if (data.exerciseRecord) {
          set({
            exerciseRecord: data.exerciseRecord,
            activityList: data.activityList ?? [],
          });

          const todaysActivity = get().activityList.find(
            (p: Activity) => p.date?.toString() === get().date.toString()
          );
          if (todaysActivity) {
            set({ activity: todaysActivity });
          }
        }

        get().feedInitialGeminiData(data.activityList ?? []);
        get().startStepCounter(data.userData);
      }

      router.navigate("/(tabs)");
    }
  },

  signOut: async () => {
    try {
      await GoogleSignin.signOut();
      set({
        userInfo: null,
        userData: {
          weight: 0,
          height: 0,
          stepGoal: 10000,
          caloriesGoal: 700,
          distanceGoal: 3000,
        },
        exerciseRecord: [],
      });
      router.dismissAll();
    } catch (error) {
      console.log(error);
    }
  },

  setUserData: async () => {
    try {
      const email = get().userInfo?.user.email;
      if (!email) return;

      const userRef = firestore().collection("Users").doc(email);
      await userRef.set({
        userData: get().userData,
        exerciseRecord: get().exerciseRecord,
        activityList: [],
      });

      await get().startStepCounter(get().userData);
      router.navigate("/(tabs)");
    } catch (error) {
      console.log(error);
    }
  },

  // ---------- Pedometer / exercise ----------

  startStepCounter: async (userData: UserData) => {
    try {
      get().stopStepCounter();

      const isAvailable = await Pedometer.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert(
          "Pedometer not available",
          "Step count will not work because the device lacks necessary sensors"
        );
        return;
      }

      let perms = await Pedometer.getPermissionsAsync();
      if (!perms.granted) {
        await Pedometer.requestPermissionsAsync();
        perms = await Pedometer.getPermissionsAsync();
        if (!perms.granted) {
          Alert.alert(
            "Permissions Required",
            "Please allow access to track workout data from settings."
          );
          return;
        }
      }

      const currentSteps = get().activity.steps;

      subscription = Pedometer.watchStepCount((stepCount) => {
        const newSteps = stepCount.steps;
        const steps = currentSteps + newSteps;

        const caloriesBurnt = get().calculateCalories(
          steps,
          userData,
          get().exerciseIntensity,
          get().currentExercise || "walk"
        );
        const distance = get().calculateDistance(
          steps,
          userData,
          get().exerciseIntensity
        );

        set({ activity: { steps, caloriesBurnt, distance } });

        if (get().isExercising) {
          const currentExerciseData = get().exerciseData;
          if (currentExerciseData) {
            set({
              exerciseData: {
                ...currentExerciseData,
                steps: steps - get().refActivity.steps,
                calories: parseFloat(
                  (caloriesBurnt - get().refActivity.caloriesBurnt).toFixed(1)
                ),
                distance: parseFloat(
                  (distance - get().refActivity.distance).toFixed(1)
                ),
              },
            });
          }
        }
      });
    } catch (error) {
      Alert.alert(
        "Error",
        "Failed to start step counter. Please try again later."
      );
    }
  },

  stopStepCounter: () => {
    if (subscription) {
      subscription.remove();
      subscription = null;
    }
  },

  calculateCalories: (
    steps: number,
    user: UserData,
    intensity: number,
    exercise: string
  ): number => {
    const metValues: { [key: string]: { [key: number]: number } } = {
      walk: { 1: 2.0, 2: 3.0, 3: 4.0 },
      sprint: { 1: 6.5, 2: 11.0, 3: 14.0 },
    };

    const met = metValues[exercise][intensity];
    const caloriesBurnt = met * user.weight * steps * 0.0005;
    return parseFloat(caloriesBurnt.toFixed(1));
  },

  calculateDistance: (
    steps: number,
    user: UserData,
    intensity: number
  ): number => {
    const strideLengthFactors: { [key: number]: number } = {
      1: 0.4,
      2: 0.414,
      3: 0.45,
    };

    const strideFactor = strideLengthFactors[intensity];
    const strideLength = user.height * strideFactor;
    const distanceMeters = (steps * strideLength) / 100;
    return parseFloat(distanceMeters.toFixed(1));
  },

  startExercise: () => {
    if (!get().isExercising) {
      const startTime = Date.now();
      set({
        exerciseData: {
          exercise: get().currentExercise,
          steps: 0,
          calories: 0,
          distance: 0,
          intensity: get().exerciseIntensity,
          startTime,
        },
        refActivity: { ...get().activity },
      });
    } else {
      const currentExerciseData = get().exerciseData;
      if (currentExerciseData) {
        set({
          exerciseRecord: [...get().exerciseRecord, currentExerciseData],
        });
        set({
          exerciseData: null,
          refActivity: { steps: 0, caloriesBurnt: 0, distance: 0 },
          exerciseIntensity: 1,
          currentExercise: "walk",
        });

        const email = get().userInfo?.user.email;
        if (email) {
          const userRef = firestore().collection("Users").doc(email);
          userRef.update({
            exerciseRecord: get().exerciseRecord,
          });
        }
      }
    }

    set({ isExercising: !get().isExercising });
  },

  updateDailyStats: async () => {
    try {
      const email = get().userInfo?.user.email;
      if (!email) return;

      const userRef = firestore().collection("Users").doc(email);
      const userSnapshot = await userRef.get();
      const data = userSnapshot.data();

      if (data) {
        const currentDate = get().date;
        const list = [...get().activityList];
        const activityIndex = list.findIndex(
          (a: Activity) => a.date === currentDate
        );

        if (activityIndex > -1) {
          list[activityIndex] = { ...get().activity, date: currentDate };
        } else {
          list.push({ ...get().activity, date: currentDate });
        }

        set({ activityList: list });

        await userRef.update({
          activityList: list,
        });
      }
    } catch (error) {
      console.log(error);
    }
  },

  // ---------- Meals API ----------

  fetchCat: async (category: string) => {
    try {
      const response = await fetch(
        `https://www.themealdb.com/api/json/v1/1/filter.php?c=${category}`
      );
      const data = await response.json();
      set({ meals: data.meals || [] });
    } catch (error) {
      console.log(error);
    }
  },

  fetchIngred: async (ingred: string) => {
    set({ mealLoading: true });
    try {
      const response = await fetch(
        `https://www.themealdb.com/api/json/v1/1/filter.php?i=${ingred}`
      );
      const data = await response.json();
      set({ meals: data.meals || [] });
    } catch (error) {
      console.log(error);
    }
    set({ mealLoading: false });
  },

  fetchMealData: async (id: string) => {
    try {
      const response = await fetch(
        `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${id}`
      );
      const data = await response.json();
      set({ mealData: data.meals?.[0] ?? null });
    } catch (error) {
      console.log(error);
    }
  },

  // ---------- Gemini chat ----------

  getGeminiResponse: async (prompt: string, image: string | null = null) => {
    const { contextHistory } = get();
    set({ geminiLoading: true });

    try {
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const chat = model.startChat({ history: contextHistory });

      let result;

      if (image) {
        let base64: string;

        if (Platform.OS === "web") {
          const response = await fetch(image);
          const blob = await response.blob();

          base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => {
              const dataUrl = reader.result as string;
              const commaIndex = dataUrl.indexOf(",");
              resolve(
                commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
              );
            };
            reader.readAsDataURL(blob);
          });
        } else {
          base64 = await FileSystem.readAsStringAsync(image, {
            encoding: "base64",
          });
        }

        const imagePart: Part = {
          inlineData: {
            data: base64,
            mimeType: "image/png",
          },
        };

        result = await chat.sendMessage([prompt, imagePart]);
      } else {
        result = await chat.sendMessage(prompt);
      }

      const response = result.response;
      const text = response.text();

      set({
        messages: [
          ...get().messages,
          {
            message: text,
            ai: true,
            time: new Date().toLocaleTimeString().slice(0, -3),
          },
        ],
        contextHistory,
      });

      return text;
    } catch (e) {
      console.log("Gemini error", e);
      Alert.alert("Error", "Failed to get response from Gemini.");
      return "";
    } finally {
      set({ geminiLoading: false });
    }
  },

  feedInitialGeminiData: async (activityList: Activity[]) => {
    try {
      const history = get().contextHistory;
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const chat = model.startChat({
        history,
      });

      await chat.sendMessage(
        `This is my all time workout statistics based off of which I can ask questions so remember it. ${JSON.stringify(
          activityList
        )}`
      );

      set({ contextHistory: history });
    } catch (error) {
      console.log(error);
    }
  },
}));
